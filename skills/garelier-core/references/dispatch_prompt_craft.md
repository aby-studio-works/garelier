# Dispatch prompt craft — 指示文の書き方と model 別の書き分け

PM が producer / gate subagent へ出す prompt の**中身の設計**(craft)の正本。
「どう起動するか」は `role_subagent_dispatch.md` / `codex_worker_playbook.md`、
「どの seat にどの tier か」は `model_routing.md` が正本 — 本書はその上の
「何をどう書くと事故らないか」だけを扱う。実戦由来 (target project 2026-06〜07、
false-green ×2 / REWORK 回収 / quota 死 resume 等の回収 trail から一般化)。

## 1. 共通骨格 — どの model の producer にも入れる 7 点

1. **正本 pointer + AC 番号化**: blueprint / backlog row の path と、満たすべき AC を
   番号付きで列挙。「〜を実装して」だけの自由記述は scope drift の温床。
2. **scope fence + 終端明示**: 触ってよい path glob を列挙し、末尾に
   「**他の file / scope に触らない**」を必ず書く。resume では「やること (これだけ)」
   見出しで単数化する。
3. **証跡契約 (最重要)**: 完了 claim は **verbatim 出力行**で要求する —
   `test result: ok. N passed; 0 failed` の行そのもの、cooker は `--validate-only` の
   実 exit。**「EXIT=0」「passed」という要約 claim は不可**と明記。pipe 越しの exit は
   `${PIPESTATUS[0]}` で取らせる (`cmd | tail; echo $?` は tail の 0 を拾う false-green
   実害あり)。多 crate test は `--no-fail-fast` + per-crate pass 行。
4. **premise 反証条項**: 着手前 5-10 分で前提 (対象 symbol の実在 / 現象の再現) を機械
   確認し、崩れていたら実装せず BLOCKED + 2-3 案で register する (worker manual §3)。
   前提が stale だった row を黙って「直せた事にする」のが最悪 pattern。
5. **RED checkpoint の宣言**: TDD で意図的に RED を作る工程があるなら「この時点の
   compile error / test fail は意図された checkpoint」と prompt に書く。書かないと
   stall 監視や次の PM がRUNAWAY/失敗と誤判定する。
6. **register 終端形式**: 最終 message の 1 行目に `REGISTER #<id>` + gate 結果の
   数字列 + ledger 消費 + report path。長文は report.md へ、register は要約。
   **Claude teammate (named Agent) の register は SendMessage で team-lead へ明示送信
   させる** — 最終 turn の plain text 出力は lead に配信されないことがある
   (field #336 実害: 「register を書いたが text-only で送信されず」、W-078 の
   final-message 版)。prompt に「最終 register は SendMessage(to=team-lead) で送る。
   plain text で終えない」を書く。
7. **commit 契約**: commit してよい seat なら message 形式 (`[#id]` + Garelier trailer)。
   **proxy seat (sandbox で commit 不可) なら「commit 不可は正常、Dock seat が
   proxy-commit する」と prompt に明記** — 書かないと producer が index.lock denial を
   障害として BLOCKED 停止する。
8. **出力先の明示 (stray dir 予防)**: producer/tool の生成物は必ず明示 path へ —
   user 向け = `showcase/<topic>/`、中間 = `runtime/scratch/<lane>/`、tool は
   `--output-path` 明示。**cwd 相対で新 dir を作らせない** (gitignore 域、特に
   `target/` 直下に相対出力すると git からも見えず静かに堆積する class)。
9. **heavy 実行の逃がし先を正しく指定 (silent idle 予防、W-078 実害 2 件)**:
   「heavy は run_in_background で」と一律に書かない。**budget 内 (warm per-crate
   test / scoped check ≲10 分) は foreground で回させる** — background に逃がすと
   完了 wake が配信されず silent idle になる class がある (§6 W-077「自動 re-wake に
   依存しない」)。background を許すのは cold 長走 (workspace compile 級) だけで、
   その場合 **PM は dispatch_watch / waiter を必ず対で arm する** (producer 側の
   規律だけに頼らない)。producer には「background で turn を終えたら次 turn 冒頭で
   必ず output file を読む」を書く。
10. **tool call 直前に prose を置かない (malformed tool-call 予防、W-097)**: Opus 4.8
   は tool call の直前に説明文/前置きを置くと稀に turn を壊す (stop_reason=tool_use
   なのに tool_use block 欠落 = jam して cascade する 2026-05-29+ 回帰)。全 producer
   prompt に **「tool を呼ぶ turn は、呼ぶ直前に説明文を書かない。最初の応答が tool
   call になるようにし、説明は call の後に回す」** を入れる。発症したら **prose を
   一切書かず tool call 単独の turn で再送** (壊れた turn は破棄) で回復する。検出は
   dispatch_watch `--transcript` の MALFORMED-CALL / fleet_watch `--pm-transcript` の
   malformed_self が担う (気づけないと回復できないため検出が先)。連発する seat は
   Opus 4.7 へ downgrade か reasoning effort 低下で即時回避。
   ([[feedback_tool_call_no_prose_before]])

## 2. Model 別の書き分け

### Codex (gpt-5.6-sol / terra) — self-contained 必須
- **skill も CLAUDE.md も読まない**。違反即 gate-fail の規約 (import 防火壁 / prefix
  runtime 判定禁止 / 防御層配置など) は **prompt に抜粋を直接埋め込む**
  (`codex_worker_playbook.md` § prompt 設計が正本)。
- **sol (high)** = 大型実装 wave・外部視点監査 (Claude が Claude を監査すると視点が
  消えるため監査は codex 固定)。**terra (medium/low)** = 小粒 fix・resume・probe。
  quota は週次予算 — sol high 連打は 1 日で週分を焼く。大型 wave は quota リセット
  直後に投入し、mid-run 死は「部分成果を file 単位監査 → resume prompt に積み残しを
  列挙」で継続する。
- 対話不能・一発勝負。**曖昧さを残すと最も高くつく model** — file path、実行 command、
  期待出力を全て具体で書く。「適切に」「必要なら」を書かない。
- resume は「受領済み成果の明示 + 残作業の単数化」: どこまで受領済みかを冒頭で確定
  させないと、済んだ作業をやり直して quota を焼く。

### Claude opus — gate / 設計 review / 判断密度の高い調査
- 自走できるので inline 埋込は不要 — **read-first pointer** (field manual / verdict
  template) と **focus list** (観点の番号列挙) だけ固定する。
- gate prompt は追加で: (a) review 対象を **SHA で pin**、(b) diff command を丸ごと
  提示、(c) **Dock 検証済み事実を「treat as verified, do NOT re-run heavy builds」と
  列挙** — 書かないと gate が workspace build を再走して 30 分溶かす。(d) verdict は
  bare-token marker file (path 明示) + 所見は file:line 証跡必須。
- re-gate では**前回所見を番号列挙して「各々が直っているか」を問う** — 新規 review を
  やり直させると観点がずれて別の note が湧き、収束しない。

### Claude sonnet — 機械的中粒
- 手順列挙型 (1..N の実行手順 + 各手順の検証 command) に寄せ、**判断余地を残さない**。
  探索・設計判断が要る task は sonnet に出さず opus / codex sol へ。
- 大量並列 fan-out (docs 同期 / 機械的 rename / 調査 sweep) の既定 seat。

## 2b. 役別の追加条項 — model 軸と直交して入れるもの

共通骨格 §1 は全役共通。役ごとに**上乗せ**する条項:

- **Guardian / Observer (gate)**: review pattern の選定 (状況→観点→なぜ) は
  `gate_field_manual.md` **§C 選定表**が正本。§2 opus 節の 4 点 (SHA pin / diff command 提示 /
  Dock 検証済み列挙 / verdict marker 契約) に加え、**役の焦点を分離して重複させない**
  — Guardian = 境界・保護・scope fence 侵犯・allowlist 改変・unsafe、Observer =
  AC 充足・spec 整合・test 品質・coverage 境界。同じ観点を両方に書くと片方が
  形骸化する。re-gate は前回所見の番号列挙 + 「直っているか」限定。
- **Artisan**: singleton lane — prompt に satchel branch 名 + `lane.lock` 規律 +
  「integrate 前に自 gate (G→O) を通す」を明記。Artisan は自分で studio へ merge
  する役なので、**merge 条件 (gate green + base-track 済) を prompt 内 checklist 化**
  しないと gate 前 merge の事故になる。
- **Scout**: 「**commit しない / code を書かない**」を冒頭に。成果物 = inspection
  draft の path 指定 + 構成契約 (summary / source path / 件数 / sample / 再現
  command — raw dump 禁止)。**結論には反証試行を添えさせる** (「〜と考えたが
  X を確認して棄却」) — Scout の誤断定は PM の計画を狂わせるが gate が無い。
- **Smith**: 対象 = studio 統合後の hardening のみ。「機能追加禁止 / 挙動変更は
  regression test 同梱必須」の fence。integration 視点の focus list
  (`quality/integration_hardening_views.md`) を pointer で渡す。
- **Librarian**: 知識の**一般化**が任務 — 「project 固有名を落として原理化する /
  policy 意味変更は PM 承認事項で勝手に再決定しない」を明記。
- **Concierge**: 外部作用 (push / tag / release) — **dry-run 出力 → 承認 → 実行**の
  3 段を prompt に固定。SHA/tag は実在検証してから外部作用 (捏造 register の実害
  class)。

### 共通の罠 (model 指定)
- **Agent tool は `model:` 省略時に親 (PM) の model を黙って継承する** (W-049)。
  gate も producer も必ず明示。`dispatch_prepare.sh` JSON の `spawn_directive` /
  `gate_agents.*.model` を verbatim 使用。PM が Fable 級なら省略 = 高価な誤継承。
- subagent 名は `ga-<step>-<slug>` (colon 不可、`workflow-naming.md` §5)。

## 3. Resume prompt の型 (quota 死 / rework 差し戻し共通)

```
# RESUME #<id> — <単数化した残作業> (N 件のみ)
<受領済み成果の列挙 — file 名 + 検証済み事実>
<エラー/指摘の verbatim 引用>
**真因**: <1 段落。file:line 付き>
## やること (これだけ)
1. <最小 fix。実装例 1 行付きでもよい>
2. <検証 command + verbatim 記録指示>
3. Register-terminate。<commit 契約の再掲>
他の file / scope に触らない。ledger 追加消費なし。
```

- 真因を PM が書く (producer に再調査させない) — 差し戻しの roundtrip を 1 回で
  収束させる鍵。ただし真因が未確定なら「真因調査から」と正直に書き、fix と分離する。

## 4. 委譲表 — 本書が扱わないもの

| 内容 | 正本 |
| --- | --- |
| seat → model tier の決定 | `model_routing.md` |
| 起動機構 (Agent tool / dispatch_prepare / helper) | `role_subagent_dispatch.md` |
| Codex 固有 (helper 経由 / sandbox / quota / self-contained 詳細) | `codex_worker_playbook.md` |
| gate の verdict 契約 / prompt 原型 | `attended-gate-dispatch.md` + `gate_field_manual.md` |
| producer 側の義務 (premise 反証 / report 形式) | `worker_field_manual.md` |
| 設計 campaign の review cycle (opus 案 → Fable review) | `design_campaign_playbook.md` |
