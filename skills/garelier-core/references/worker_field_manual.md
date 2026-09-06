# Worker / Scout field manual — 判断不要の手順表・決定表

実装をやる role（Worker / Scout）が**判断で詰まった実例**を、判断なしで execute できる
決定表・checklist に落としたもの。SKILL.md / `debugging_discipline.md` /
`worktree-addressing.md` に散在する rule を、role が**着手 → 実装 → REPORTING**の一本道で
踏む順に stitch し直した実行 view。詳細 rule は各節末尾の pointer を開く（重複させない）。

**使い方:** トリガに合致したら右列を verbatim。command は placeholder（`<pm_id>` `<root>` `<N>`）を
埋めて走らせる。**迷ったら止まって file を実査する**（記憶・assignment の額面で動かない）。
read-on-demand（常駐させない）。

Scout は commit-free（detached HEAD、inspection draft のみ）— §2 lock（heavy build を伴う時のみ）と
§7（commit に混ぜない）は Worker 中心。他は Scout も同じ。

blueprint を受け取ったら着手前に
[`blueprint-output-contract.md`](blueprint-output-contract.md) を適用する。出力定義の読み方・
欠落時の停止・成果物の受入条件はこの共通正本が持つ。

---

## 0. 索引

| トリガ | 節 |
| :-- | :-- |
| cargo / 編集 / commit を始める前 | §1 cwd 規律 |
| heavy build（full-workspace 等）を走らせる | §2 lock 規律 |
| assignment を読んで実装に入る前 | §3 前提検証 |
| blueprint から成果物を作る | `blueprint-output-contract.md` |
| 修正の効果を測る | §4 交絡排除 |
| 完了して報告する | §5 register 終端 |
| register に gate step を書く（provider を問わず必須） | §5b REQUIRED GATE block |
| REPORTING に入る前 | §6 instruction ledger |
| diff に無関係な warning / 欠陥を見つけた | §7 pre-existing hygiene |

---

## 1. cwd 規律 — 全操作は自分の worktree の中で

**大原則: cargo・編集・commit は必ず自分の `…/checkout/` worktree の cwd で行う。**
親 repo / primary checkout / 他 agent の worktree で走らせると、成果と検証 evidence が
別 branch（studio 等）に misplace され、**検証が丸ごと無効化する**（誤走 2 回の実害）。

**手順（bash tool は毎回 cwd を reset するので毎コマンド絶対 path + 冒頭で確認）:**

1. 編集・commit の前に、自分がどの worktree に居るか機械確認する:

```bash
git -C <自分の checkout 絶対 path> rev-parse --show-toplevel
```

   これが自分の `…/_crew/workers/<id>/checkout`（Scout は `…/_crew/scouts/<id>/checkout`）で**なければ止まる**。
   `target_root` / primary checkout / container / 他 worktree に解決したら操作しない（DEC-020 worktree guard）。
2. Edit / commit は全て自分の checkout 配下の path で。coordination file（`STATE.md` `report.md`
   `instructions.md`）は checkout の **外**（container 直下 = `../report.md` 等）— checkout 内に置かない。

**書ける場所は 2 箇所ちょうど（W-485、2026-09-03 に文面を grant と一致させた）:**

| 場所 | 例 | 可否 |
| :--- | :--- | :--- |
| 自分の checkout worktree | `…/checkout/**` | 書ける |
| 自分の container 直下の canonical artifact | `../report.md` / `../STATE.md` / `../instructions.md` / `../lane/` | 書ける — **これを書くことが「報告する」ということ** |
| container のそれ以外 | `../context.json` / `../ready.json` / 他 role の container | 書けない |
| primary checkout / 親 repo / 共有 gitdir / 他 lane | — | 書けない |

「worktree の外は一切書くな」という旧文面は launcher の write grant
（`codexProviderWritableRoots` = worktree + container + result dir）と**食い違っていた** —
role が自分の必須 artifact を禁止事項と読み、recovery 経路を常用化していた。grant を縮めるのでは
なく文面を grant に合わせた（PM 裁定 FORK-F）。

**path の綴り（W-354、2026-09-03）:** MSYS の `/c/env/...` 形と `C:/env/...` 形は guard 内で
同一 path として扱われるようになった（`normalizePathFlavor`）。それでも **drive-letter 形を
既定にする** — 正規化は win32 host だけの規則で、drive-letter 形の方が host に依らず一意。

→ `worktree-addressing.md` §1–§4、worker `references/working-and-reporting.md` §1a

---

## 2. lock 規律 — heavy build は acquire→release を trap で括る

full-workspace 等の heavy build を自分で走らせる時（**scoped self-gate は不要**。§quality gate は
per-package で軽い）、`heavy_compile_lock` を build の**直前 acquire・直後 release**で括る。
握ったまま眠らない・他作業しない（保持待機禁止）。異常終了でも解放されるよう `trap` を張る:

```bash
TOKEN=$(bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode acquire --label <slug> --owner-pid "$$")
trap 'bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode release --token "$TOKEN"' EXIT
#   … heavy build …（TOKEN=="OPEN" は lock infra 故障なので ABORT。lockless 実行禁止）
```

自分の self-gate が per-package で収まる限り lock は不要（RAM を食わない）。full-workspace を
foreground に入れない — それは merge gate の仕事（DEC-091）。foreground が budget
（`context.json` の `bash_timeout_budget_ms`）を超えそうなら BLOCKED（`gate exceeds foreground budget`）。

`--owner-pid "$$"` は build 中も生存する呼出し shell の PID。one-shot wrapper 自身の PID や
`$!` を渡さない。安定 PID を供給できない呼出し形は省略可（owner は `unknown` と記録され、
`stale_minutes` 猶予 + cargo/rustc 実在確認後だけ回収）。

→ pm_playbook §6、`role_subagent_dispatch.md` §4/§6、`debugging_discipline.md` §5

---

## 3. 実装前の前提検証 — premise を反証してから作る

**大原則: assignment の premise（「X が壊れている」「Y が無い」）を、作り始める前に 5–10 分で
反証確認する。** 症状が assignment の主張と食い違うことがある（環境由来の赤 herring を、実装せず
実走で見抜いた好例あり — 「壊れている」とされた経路が実は環境設定の副作用だった）。

**手順:**

1. premise を 1–2 個の機械確認に落とす（`git show <sha>:<path>` / `grep` / 最小の実走 / log 計装 1 本）。
2. 確認が premise を**支持**したら実装に入る。
3. premise が**崩れたら実装しない** — `state=BLOCKED` を返し、**選択肢 2–3 案を 1 message で**提示
   （「A: premise を X に読み替えて実装 / B: 別経路 Y を疑う / C: 追加情報が要る」）。推測で
   代替実装に走らない。不可逆手（restart / delete / config 変更）は evidence が支持する時だけ。

→ `debugging_discipline.md`（observe→hypothesize→verify→fix）、pm_playbook §9

---

## 4. 検証の交絡排除 — A/B は片方を無効化して単独測定

修正 X の効果を測るなら、既存の bypass / fallback / 旧 path を**先に off にして単独で測る**。
bypass が入ったまま before/after を測ると、効いているのが X か bypass か切り分けられず結論が交絡する。
2 経路 on のまま比較しない。

→ pm_playbook §9

---

## 4b. census は分母とセットで報告する — 「N 件」だけでは evidence にならない

数を報告する時は、**何を対象に走査して N 件か**を必ず併記する。M の無い「N 件 clean」は
主張であって証拠ではなく、gate 席は分母を自分で数え直す（gate_field_manual §A-3b）。

- **自分が触った範囲を全体として報告しない。** 「この diff に該当 0 件」と
  「crate 全体に該当 0 件」は別の主張。前者しか確かめていないなら前者と書く。
- **`0` を 2 通りに分けて書く。** 「対象を走査して 0 件」と「対象を解決できず 0 件」は
  別物。tool が `scan_state` / `coverage` / `failure` を返すなら、件数と一緒に載せる。
  **分母が空のまま PASS を coverage として報告しない。**
- **否定主張には存在主張と同じ証拠を付ける。** 「該当なし」「近いものが無い」「未使用」を
  書く前に、存在を確かめるのと同じ手順で確かめる。**指示や blueprint が「無いと書いてよい」と
  許していても、検証の免除ではない。**
- **blueprint が名指しした対象と、実際に走査した対象が同じか確認する。** 違うなら、
  数字が正しくても結論は使えない。違いに気づいたら register に書いて escalate する。
- **再走可能な形で残す。** 検査 command を書くなら、**container ではなく成果物側**に置く。
  dispatch container は掃除で消えるので、そこにしか無い command は次の席に届かない。

→ gate_field_manual §A-3b

---

## 5. register 終端 — 1 本 / 新 SHA + 結果 / 長文は part 分割

- 完了時に **final message を 1 本だけ**返す（commit / report を書いた**後**、途中や事前でなく）。
  本文に **新 SHA + 結果**を含める。
- final message が長い時は **`part 1/N` `part 2/N` … に分割**する（最初の part で N を宣言し順に送る）。
  1 message に押し込んで截断されるより分割が正。
- BLOCKED も同様に 1 本で（§3 の 2–3 案付き）。
- **散文の SHA は自由、束縛は typed field だけ**（W-708 / DEC-100 裁定 2）。register 本文に
  別 commit の完全 40 桁 SHA を引用しても binder は落ちない。束縛の正本は `[gate] review_sha` /
  `declared_base_sha` の 2 field で、**どちらも driver が書く**（W-709 / DEC-100 P1）—
  `bind_review_sha` が candidate checkout の HEAD と dispatch binding の pickup base から導出する。
  producer が同名 field を書いても refuse されず、上書きした事実が
  `driver_overwrote=<field…>` として binder の出力に出る。**自分で書く場所は無い。**
  `[gate] gate_log` / `candidate_stat` も同じ driver 専有 field で、**`review_sha` と 1 組**として
  毎 bind 書き直される（W-720）。round を跨いでも log pointer が 1 round 古いままになることは無く、
  `lane/result.md` と `report.md` の両方に同じ stamp が当たる。
  終端宣言の正本も同じく front matter の `[lane].state` — `GARELIER_RUNTIME_STATUS` marker は
  その横に置く観測行で、**位置も個数も検査されない**。
- **節目（commit 済 / gate 完了 / step 完了）で turn を黙って終えない。** subagent は
  run-to-completion — turn が終わると**外部 message が来るまで再起動されない**（自己継続なし）。
  だから turn の終わりは常に次の **どちらか**にする: **(i)** 完了なら §上記の register 1 本、
  **(ii)** 続きがあるなら「次に X をやる」の進行 message を 1 本返す**か**、走行中の
  background 作業（build / test を `run_in_background`）を残したまま終える。commit した直後に
  何も言わず沈黙して終えると、PM から見て「REPORTING 未着 = 停滞」と区別できず、`--stall-scan` の
  `IDLE-NO-REGISTER` / `unwatched` に載って PM の手 wake が要る（fleet_watch が拾う停滞の主因）。
  **逆に、完了を宣言した lane は停滞として fire しない** — watch は lane 自身の宣言
  (`lane/result.md` 先頭の `STATE=REPORTING|BLOCKED`、無ければ STATE.md の Status 見出し)
  を読み、宣言済なら `DECLARED-DONE` を返す。だから**宣言の形を守ることが誤検知を防ぐ**:
  1 行目は canonical grammar ちょうど（`STATE: …` / 2 行目以降 / 小文字は宣言と認めない）。
  編集中の checkout も進行として数えられるので、commit 前でも stall にはならない。

→ `output_control.md`（compressed register）、`compact_handoff.md`、`role_subagent_dispatch.md` §6（停滞 taxonomy）

---

## 5b. REQUIRED GATE block — provider を問わず register に必須（W-641）

**この節が REQUIRED GATE の正本。** codex / claude (attended-agent / claude-subprocess) の
どちらの席でも同じ形で書く。prompt preamble の文言は
`lane_common.ts` の `requiredGateDelegationContract()` 1 定義から両 provider へ配られる
（理由句だけが provider ごとに違う: codex = sandbox が heavy_compile_lock を取れない /
claude = required gate は Dock 席が `--from-register` で走らせる）。

- **required project gate は自分で走らせない。** Dock 席が
  `review_prepare.ts` → `gate_runner.ts --from-register <register>` で実行する。
  自分で走らせるのは scoped な per-package check / test まで。
- register の末尾に **bare command 行**で block を 1 つ置く:

  ```text
  === REQUIRED GATE (Dock-run) ===
  <one bare project-declared command per line>
  === END REQUIRED GATE ===
  ```

- **block が無い register は `REGISTER_REFUSED required_gate_block_missing` = RED。**
  project 固定 step への fallback は無い（あると PM 選定 step を宣言する席が消える）。
  RED のままでは `final_accounting.md` が `Gate result: GREEN` にならず、
  Guardian / Observer seat は永久に発行されない。
- 各行は checkout root 相対の **bare command** で、`[quality_gate.register.steps]` の
  `command_prefixes` のいずれかに前方一致すること。inline env wrapper / `cd … &&` は
  project 宣言がその prefix を持つ時だけ。runner は最小・secret-scrub 済み環境で実行する。
- **PM 選定 step**（user 裁定 2026-08-29）= 「この round の fix を戻すと RED になる test」を
  1 本。`bun test <file> -t "<pattern>"` の `-t` は **regex** なので、`+` `(` 等の metachar を
  含む scenario 名は 0 件一致 → exit 1 で fail-closed になる。metachar を含まない一意な語を選び、
  log の実出力に probe 名が出たことを register に書く。
- whole-file / full CI の実走は gate step ではなく supporting evidence として別行に書く。
- register は **worktree が clean で最終**の時だけ出す。

→ `garelier-core/references/pm_field_manual.md#pmfm-15-3`（PM 側の選定と代行）、`codex_worker_playbook.md`（codex 固有の sandbox 事情）

### 5b-1. register 契約 6 件 — 手順書に無くて必ず 1 度踏むもの（W-668）

下の 6 件は、いずれも**拒否 message で初めて知る**形だった（2026-09-02 の land 3 本で全数実測、
addenda F-18〜F-26）。**この表が 6 件の正本**で、`codex_worker_playbook.md` /
`gate_field_manual.md` / `attended-gate-dispatch.md` / `dispatch_prompt_craft.md` /
`garelier-core/references/pm_field_manual.md#pmfm-15-3` は本表を参照する。

| # | 契約（守る形） | 破った時に出るもの | 正本 |
| ---: | :--- | :--- | :--- |
| 1 | `bun test` の positional は **`*.test.ts` / `*.spec.ts` の file 列挙のみ**。directory を渡さない（positional 無しも可） | `ABORT_STEP_REJECTED … unsupported Bun test positional argument` | `gate_step_ledger.ts::parseBunTestArgv` |
| 2 | control doctor は **bun 形**（`bun skills/garelier-core/driver/src/scripts/control.ts doctor --profile strict …`）。`garelier control doctor …` の shim 形は書かない | STEP は計画されるが実行段で `Executable not found in $PATH: <...>/bin/garelier` → RESULT RED。`FAILURE SUMMARY` には出ない | `[quality_gate.register.steps]` の `control-validate` prefix |
| 3 | **closure と byte 同一の command は畳まれ、coverage に数えない**。closure と同じ tsc 行を書くなら `--pretty false` 等で**非同一**にする | `UNCOVERED <path> -> no coverage rule` → `RESULT REFUSED`。coverage rule に closure 名を足しても `covered_by_closure_only_…` で数えない | `[quality_gate.register.closure]` |
| 4 | `report.md` の **1 行目は `+++`**。機械 header（`<!-- garelier-control-v3 … -->`）を front matter の前に置かない — 置くなら `[control]` table として front matter の中へ | `retired body-regex form - the first line is …` で `review_prepare` が exit 1 | `machine_artifact.ts` |
| 5 | `instructions.md` の `[[instruction]]` table は **front matter の `+++` の内側**。閉じ `+++` の外へ append すると機械 reader からは不在 | ledger が空に見え、`contract_check --stall-scan` の UNCONSUMED 判定が効かない | `dispatch_prepare.ts::instructionLedger` |
| 6 | gate verdict marker は **front matter `[verdict]` と `## Verdict` 節の両方**を書く（読み手が 2 つある） | 片方だけだと他方が refuse（§A-1 / `garelier-core/references/pm_field_manual.md#pmfm-10`） | `templates/gate_verdict.md` |

**1 command 化**: PM 側はこの 6 件を
`skills/garelier-core/driver/src/scripts/land_pipeline.ts` が自動で満たす（register 受領 →
land → cleanup）。producer 側で守るのは 1〜3 と、register を出す時点の 4。

**表から消えたもの**: 旧 4「`[gate] declared_base_sha` = pickup base」は **W-709 で producer の
契約ではなくなった** — driver が dispatch binding から導出して書き、producer の値は
`driver_overwrote=` で告知して上書きする（`bind_review_sha.ts`）。旧 7「gate 出力を引用する
round では `[gate] gate_run_id` を書く」は **W-711 で撤回**した — seal が束縛する run は Dock
review record と gate log の digest だけで決まり、register の引用は読まれない（欠落しても
違っていても判定は同じ）。分岐の全数は `gate_field_manual.md` §A-8b の表。

→ `garelier-core/references/pm_field_manual.md#pmfm-2`（PM 側の pipeline）、`gate_field_manual.md` §A-1（marker の 2 面）

---

## 6. instruction ledger は REPORTING 前に全消化

走行中に届いた scope 追加は container の **`instructions.md`** の front matter に `[[instruction]]` table …` として溜まる。
**REPORTING に入る前に全 entry を消化**（実装 + `checked = true` と非空の `consumed` に更新）する。未消化のまま REPORTING すると
`contract_check --stall-scan` が **UNCONSUMED-INSTRUCTIONS** で差し戻す。完了間際に scope 追加 message が
register と交差しても、ledger に残るので拾える（口頭 message だけの追加は拾えない — PM 側規約 W-092）。

**REPORTING に入る前に、自分で 1 回これを走らせる**（差し戻しの最初の読み手を admission に
しない。1 回の resume を丸ごと節約できる）:

```bash
bun skills/garelier-core/driver/src/scripts/instruction_ledger_lint.ts \
  --ledger <container>/instructions.md --register <container>/lane/result.md
```

`LEDGER_LINT OK` / exit 0 なら REPORT してよい。非 0 なら 1 行 1 finding が出る。
**lint は何も直さない** — 直すのは自分である。判定する述語は admission 側
(`contract_check --stall-scan` の UNCONSUMED-INSTRUCTIONS) と**同じ module を共有**しているので、
lint が通って admission が落ちる形にはならない。

`--register` を渡すと `(consumed: …)` 行の形も見る。この block は **1 行・行末・内側 ASCII
括弧 0 個**でなければならない。中に `(` があると閉じ括弧が曖昧になり、evidence 値が途中で
切れて **最初の 1 件しか報告されない** — 症状は「evidence が無い」と見分けが付かない。

→ pm_playbook §7

---

## 7. pre-existing hygiene — 直さず報告、commit に混ぜない

**この item の commit に、変更前から在った warning / lint / 無関係な bug を混ぜない**（item-binding
hygiene）。1 commit = 1 item を守り diff を gate 可能に保つため。

- pre-existing の欠陥・warning を見つけたら **直さず** `report.md` に記し、PM に**起票提案**する
  （別 item にする）。scope を silent に広げない。
- 直したくなっても、その warning が自分の変更で**新規に入った**のか**元から在った**のかを
  `git blame` / `git show <base>:<path>` で確認してから判断する。新規なら直す、pre-existing なら報告。

→ worker SKILL §2（item-binding hygiene）、`debugging_discipline.md` §1（scope 外 は report に回す）

---

## 参照

- `garelier-core/references/pm_field_manual.md#pmfm-0` — dispatch する PM 側の決定表（対になる view）
- `gate_field_manual.md` — この成果を review する gate 役（Guardian / Observer）の決定表
- `worktree-addressing.md` / `debugging_discipline.md` / `role_subagent_dispatch.md` — 各 rule の正本
- worker `references/working-and-reporting.md` / scout `references/investigating-and-reporting.md` — state 別 workflow
- `dispatch_env.md#dispatch-declaration-axes` — `resource_class` / `heavy_tier` / `touches` の
  宣言正本 (heavy slot を turn をまたいで持つ時の `--mode progress` / `--mode probe` を含む)
- `gate_field_manual.md` §A-3c — 行生存 census（「旧 file の行がまだ在るか」）の正しい形。
  `grep -Fqx "$l"` は `-` 始まりの行を option として食い、生存している行を LOST と数える。
  `grep -Fqx -e "$l"` か `comm -23` を使う
- `gate_field_manual.md` §F — incident の記録先が自分の container と食い違う時の読み方
  （繰り返しは coalesce されるので `incidents.jsonl` の行数は発生回数ではない）
