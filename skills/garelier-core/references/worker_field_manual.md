# Worker / Scout field manual — 判断不要の手順表・決定表

実装をやる producer（Worker / Scout）が**判断で詰まった実例**を、判断なしで execute できる
決定表・checklist に落としたもの。SKILL.md / `debugging_discipline.md` /
`worktree-addressing.md` に散在する rule を、producer が**着手 → 実装 → REPORTING**の一本道で
踏む順に stitch し直した実行 view。詳細 rule は各節末尾の pointer を開く（重複させない）。

**使い方:** トリガに合致したら右列を verbatim。command は placeholder（`<pm_id>` `<root>` `<N>`）を
埋めて走らせる。**迷ったら止まって file を実査する**（記憶・assignment の額面で動かない）。
read-on-demand（常駐させない）。

Scout は commit-free（detached HEAD、inspection draft のみ）— §2 lock（heavy build を伴う時のみ）と
§7（commit に混ぜない）は Worker 中心。他は Scout も同じ。

---

## 0. 索引

| トリガ | 節 |
| :-- | :-- |
| cargo / 編集 / commit を始める前 | §1 cwd 規律 |
| heavy build（full-workspace 等）を走らせる | §2 lock 規律 |
| assignment を読んで実装に入る前 | §3 前提検証 |
| 修正の効果を測る | §4 交絡排除 |
| 完了して報告する | §5 register 終端 |
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

   これが自分の `…/_workers/<id>/checkout`（Scout は `…/_scouts/<id>/checkout`）で**なければ止まる**。
   `target_root` / primary checkout / container / 他 worktree に解決したら操作しない（DEC-020 worktree guard）。
2. Edit / commit は全て自分の checkout 配下の path で。coordination file（`STATE.md` `report.md`
   `instructions.md`）は checkout の **外**（container 直下 = `../report.md` 等）— checkout 内に置かない。

→ `worktree-addressing.md` §1–§4、worker `references/working-and-reporting.md` §1a

---

## 2. lock 規律 — heavy build は acquire→release を trap で括る

full-workspace 等の heavy build を自分で走らせる時（**scoped self-gate は不要**。§quality gate は
per-package で軽い）、`heavy_compile_lock` を build の**直前 acquire・直後 release**で括る。
握ったまま眠らない・他作業しない（保持待機禁止）。異常終了でも解放されるよう `trap` を張る:

```bash
TOKEN=$(bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode acquire --label <slug>)
trap 'bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode release --token "$TOKEN"' EXIT
#   … heavy build …（TOKEN=="OPEN" は fail-open、そのまま進む）
```

自分の self-gate が per-package で収まる限り lock は不要（RAM を食わない）。full-workspace を
foreground に入れない — それは merge gate の仕事（DEC-091）。foreground が budget
（`context.json` の `bash_timeout_budget_ms`）を超えそうなら BLOCKED（`gate exceeds foreground budget`）。

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

## 5. register 終端 — 1 本 / 新 SHA + 結果 / 長文は part 分割

- 完了時に **final message を 1 本だけ**返す（commit / report を書いた**後**、途中や事前でなく）。
  本文に **新 SHA + 結果**を含める。
- final message が長い時は **`part 1/N` `part 2/N` … に分割**する（最初の part で N を宣言し順に送る）。
  1 message に押し込んで截断されるより分割が正。
- BLOCKED も同様に 1 本で（§3 の 2–3 案付き）。
- **節目（commit 済 / gate 完了 / step 完了）で turn を黙って終えない。** subagent は
  run-to-completion — turn が終わると**外部 message が来るまで再起動されない**（自己継続なし）。
  だから turn の終わりは常に次の **どちらか**にする: **(i)** 完了なら §上記の register 1 本、
  **(ii)** 続きがあるなら「次に X をやる」の進行 message を 1 本返す**か**、走行中の
  background 作業（build / test を `run_in_background`）を残したまま終える。commit した直後に
  何も言わず沈黙して終えると、PM から見て「REPORTING 未着 = 停滞」と区別できず、`--stall-scan` の
  `IDLE-NO-REGISTER` / `unwatched` に載って PM の手 wake が要る（fleet_watch が拾う停滞の主因）。

→ `output_control.md`（compressed register）、`compact_handoff.md`、`role_subagent_dispatch.md` §6（停滞 taxonomy）

---

## 6. instruction ledger は REPORTING 前に全消化

走行中に届いた scope 追加は container の **`instructions.md`** に `- [ ] I<n> …` として溜まる。
**REPORTING に入る前に全 entry を消化**（実装 + `- [x]` に更新）する。未消化のまま REPORTING すると
`contract_check --stall-scan` が **UNCONSUMED-INSTRUCTIONS** で差し戻す。完了間際に scope 追加 message が
register と交差しても、ledger に残るので拾える（口頭 message だけの追加は拾えない — PM 側規約 W-092）。

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

- `pm_field_manual.md` — dispatch する PM 側の決定表（対になる view）
- `gate_field_manual.md` — この成果を review する gate 役（Guardian / Observer）の決定表
- `worktree-addressing.md` / `debugging_discipline.md` / `role_subagent_dispatch.md` — 各 rule の正本
- worker `references/working-and-reporting.md` / scout `references/investigating-and-reporting.md` — state 別 workflow
