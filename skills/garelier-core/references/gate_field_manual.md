# Gate-role field manual — Guardian / Observer 判断表 + Observer 視点集 + PM の review pattern 選定表

merge gate を担う **Guardian / Observer** の subagent（opus / sonnet）が、判断で詰まらず
同水準の review を返すための決定表・checklist。§A が gate 役共通の手順、§B が Observer が
独立レビューの仮説を正しく立てるための視点集。verdict 意味・redaction・scope の正本は
各 role SKILL（`garelier-guardian` / `garelier-observer`）で、ここはその実行 view。

**使い方:** 判定は必ず file:line / diff evidence に接地する（DEC-088、bare な形容詞は不可）。
gate 役は verdict を**自分で書く**（DEC-090 — PM は書かない）。read-on-demand。

---

## §A. gate 役共通の手順（Guardian / Observer）

### A-1. report は正準 path + `## Verdict` 節 + token（必須）

verdict marker を、branch slug 由来の正準 path に書く（短縮名は auto-read が拾えない、W-020）:

```
__garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
__garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md
```

`## Verdict` 節の直下に **canonical token 1 個だけ**（`templates/gate_verdict.md` が雛形）。
`{{}}` menu / typo（`PASSED`）/ 截断は **null = fail-closed**（PASS にならない）。full 報告
（findings + evidence）は role の canonical report（`guardian_report.md` / `report.md`）に、
marker は machine-read 用の compact token に、と 2 本立てで書く。marker は最終 message の**前**に書く。

### A-2. 検証水準を宣言して書き分ける

review の各 finding が **どの水準で確認されたか**を明示する。混ぜて書くと読み手（PM/Dock）が
信頼度を較正できない:

| 水準 | 意味 | 書き方 |
| :-- | :-- | :-- |
| **実走で追認** | 自分で再現・実行して観測した | 「RUN: <command> → <観測>」 |
| **evidence 整合確認** | worker の evidence（log / test 出力）が diff と整合するか確認した（自分では実走せず） | 「evidence-check: <worker の主張> vs <diff の該当箇所> 整合」 |

register / report の冒頭で「何を実走し、何を整合確認に留めたか」を 1 段落で宣言する（§B-7）。

#### A-2b. gate 席が「実走で追認」できるための verify command 供給（W-159）

gate profile は fail-closed（unknown → deny、W-122 の in-fence 緩和なし）で、`bun test` /
`cargo test` 等の **preset** は自動 allow だが、project 固有の **非 preset script**（例:
`bash scripts/census.sh --full`）や **compound**（`cd checkout && <script>`）は preset に
当たらず deny される。gate 席が自分の row の検証を実走できないと「実走で追認」水準（§A-2）に
到達できない。

- **PM の運用**: gate 席を attended_record で発行するとき、その row の verify command を
  `--quality-gate <cmd>`（繰返し可）で record に積む。command_guard は record 記載の command と
  **全文 verbatim 一致**したものだけ allow する（`isDeclaredWholeCommand`）。この allow は
  **profile 非依存**（declared list を持つ任意 profile に適用）だが、実運用で list を積むのは
  gate 席だけ（他 profile は record に verify list を持たない）。絞っても forge 面は閉じず、
  deny 床が全 profile を束縛するため実装は profile で絞らない（Observer 裁定 2026-07-20）。

  ```bash
  bun .../attended_record.ts --agent ga-guardian-<slug> --worktree <checkout> --profile gate \
    --quality-gate "cd checkout && bash scripts/census.sh --full" \
    --quality-gate "bun test src/guard/command_guard.test.ts"
  ```

  `dispatch_prepare` 経由の gate 席は project fact pack の quality_gate command が同経路で積まれる。
- **laundering 防止**: 記載外 command は従来どおり deny。前方一致や記載 command への追記
  （`<listed> && rm -rf x`）は verbatim 不一致で不採用、かつ deny 床（gate_mutation / egress /
  delete / secret / force / process_kill）は**全 profile を束縛**し、strictest-wins で常に先勝ち
  する（record に `git push` を積んでも egress deny が勝つ）。だから profile で絞らなくても
  declared allow が deny 床を破ることはない。
- **gate 席側**: 検証が deny で止まったら、その command が record の `--quality-gate` に verbatim で
  積まれているかを PM に確認（register で「<command> が gate profile deny、quality_gate 未記載」と
  escalate）。gate 席が任意 script を勝手に走らせる緩和ではない。

### A-3. test の tautology 検査

追加/変更された test を鵜呑みにせず、**判別力**を検査する:

- 「この test を**旧 code に当てたら fail するか**」を問う（逆証明）。
- identifier rename だけ / no-op でも通る test = **tautology**。指摘する（bug を捕まえない test は
  緑でも価値ゼロ）。可能なら「旧実装 or 故意の逆変更で RED になるか」を実際に試して書く。

### A-4. scope 逸脱 と pre-existing の区別

finding が (a) この diff が**新規に持ち込んだ**欠陥か、(b) diff の**外に元から在った** pre-existing か
を区別する:

- (a) 新規欠陥 → verdict の根拠にする（BLOCK / REWORK_RECOMMENDED / note）。
- (b) pre-existing → **報告（起票提案）に留め、直させない**。BLOCK 材料にしない（scope 膨張防止、
  producer の item-binding hygiene と対）。`git blame` / base SHA との比較で新旧を確定してから分類。

### A-5. 判定 token と note の blocking/non-blocking を明示分離

| token | 意味 | merge |
| :-- | :-- | :-- |
| `PASS` | 指摘なし | 通す |
| `PASS_WITH_NOTES` | **non-blocking** な note のみ | 通す（note は止めない） |
| `REWORK_RECOMMENDED`（Observer のみ） | 直しを推奨（advisory の強め） | PM 判断 |
| `BLOCK` | 通してはいけない | 止める |
| `NO_OPINION` | 判断材料が無い | — |

`PASS_WITH_NOTES` の note が「merge を止める指摘」に読めてはいけない — 止めるなら `BLOCK`。
note には修正案を書いてよいが**強制しない**（advisory の本分、§B-6）。

→ Guardian SKILL §7、`../../garelier-observer/references/review-policy.md`（blocking/waiver）、
`attended-gate-dispatch.md`（dispatch prompt / refuter）

---

## §B. Observer 独立レビュー視点集（仮説の立て方）

Observer が「worker の主張をなぞる」のでなく**独立に**故障を先取りするための 7 視点。各視点に
scrub 済みの一般形実例を 1 行添える。§A の手順の上で、review の**着眼**を与える。

### B-1. 独立の定義 — 自分で再現するまで信じない

worker の主張は再現するまで採らない。再現手段を 3 つ使い分ける:

- **実走追認** — 主張された経路を自分で走らせて観測する。
- **独立再実装で突合** — 検証ロジック（validator 等）を**別言語 / 別実装**で書き直し、対象ツリー全体を
  走査して worker 実装の結果と突き合わせる（実例: 判定器を書き直して全 fixture を走査し、取りこぼしを 1 件検出）。
- **原文突合** — 引用（DEC / spec の主張）を信じず、**引用元 file を実際に開いて**確認する
  （実例: 「DEC がこう定める」の引用と、引用元の実 TOML が食い違っていた）。

### B-2. 故障仮説 → 反証探し（diff を読む前に列挙）

diff を先頭から読み下す前に、「**この変更が壊すとしたらどこか**」を先に列挙し、それを潰しに行く:

- 対称性の破れ（pack と unpack、encode と decode、add と remove）を対で確認。
- 取りこぼし（複合 key の一部だけ更新、片方の分岐だけ修正）を grep で洗う。
- 実例: bit-pack 変更で pack 側だけ直り unpack 側が旧幅のまま、を対称性チェックで検出。

### B-3. test の判別力検査（tautology 逆証明）

§A-3 と同じ — 「旧 code に当てて fail するか」。rename だけで通る test は tautology と名指しで指摘。
実例: 定数を rename しただけの test が「新挙動を検証」と称していたが、旧実装でも緑だった。

### B-4. diff の外を見る（pre-existing + diff 範囲の罠）

- diff の**外**の pre-existing 欠陥も発見したら報告する（§A-4 のとおり直させはしない、起票提案）。
- **three-dot（`git diff studio...branch`）と two-dot（`studio..branch`）を区別**する。branch を
  studio と比べるなら three-dot（merge-base 起点 = branch の変更だけ）。two-dot で見ると studio が
  先行した分を branch の変更と誤認する。実例: studio-ahead の lag を「branch が消した」と誤読しかけた。

### B-5. latent risk の言語化（今日は壊れないが将来壊れる）

現時点では動くが将来壊れる構造を、**non-blocking note** として必ず残す（将来 bug の先取り）:

- 暗黙の順序依存（system 実行順に依存するが宣言されていない）。
- 文書化されない tie-break（同点時の勝者が実装の副作用で決まる）。
- write-only field（書かれるが誰も読まない = 設計の抜けか dead）。
- 実例: 2 system の実行順に暗黙依存する集計を、順序が変われば破れる latent risk として note。

### B-6. 判定の規律 — blocking / non-blocking を分離、advisory は強制しない

- blocking（`BLOCK`）と non-blocking（note / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED`）を明示分離。
- 修正案は書くが**強制しない**（Observer は advisory、決めるのは PM/user）。
- **「REWORK にしない理由」も書く** — 指摘はあるが merge を止めない、と判断したなら、その線引きを明示する。

### B-7. 検証水準の宣言（register 冒頭）

register / report の**冒頭で**「何を実走し（RUN）、何を worker evidence の整合確認に留めたか
（evidence-check）」を宣言する（§A-2）。読み手が verdict の信頼度を較正できる。実例:
「canonical path は実走で追認、GPU 経路は worker の log と diff の整合確認に留めた」。

→ `../../garelier-observer/references/review-workflow.md`（review dimensions）、
`review-policy.md`（mandatory / blocking / waiver）、`refuter-verify.md`（高 stakes の敵対 verify 層）

---

## §C. PM の review pattern 選定表（発注側 — どの状況でどの観点を頼み、なぜか）

§B は Observer 自身の思考技法。§C はその上流 — **PM が gate prompt を書く時に
「どの review pattern を発注するか」を状況から引く表**。実戦由来 (target project
2026-07 の B2 campaign 8 gate + REWORK 回収 trail から一般化)。

選定は排他でなく**合成**: pattern 1 (AC 照合) を必ず基本に置き、状況に該当する
pattern を 2〜3 個まで重ねる (4 個以上は焦点が散って全部浅くなる)。

| # | 状況 (trigger) | 発注 pattern | prompt に書くこと | なぜこの pattern か |
| :-- | :-- | :-- | :-- | :-- |
| 1 | 全 gate 共通の基本 | **AC 番号照合** | AC を番号列挙し、各々 satisfied / deferred / missing + file:line 証跡を要求。「blueprint 明記の defer は OK、明記なき欠落は所見」と対称性を伝える | 番号がないと re-gate で所見↔AC の対応が迷子になる。defer 対称性が producer/gate の解釈揺れを消す |
| 2 | AC が test で pin される変更、test 数が少ない (新 crate 3-6 本等)、検証系 (census/audit/coverage) | **非恒真 (anti-tautology) 逆証明** | 「逆変更 (誤 kind / 破壊 / 逆順) で RED になるか」を要求。恒真形の具体例 (同値 2 回生成の等値 assert、母集合=検証対象の自己参照) を prompt に挙げる | 恒真 test は gate を素通りする false 安心を作る — 恒真 census が HOLD まで届いた実事故が起源。§B-3 を発注側から強制する形 |
| 3 | REWORK / HOLD 後の再提出 | **re-gate 限定** | 前回所見を番号列挙し「各々が直っているか」**のみ**を問う。新規観点の追加を明示的に禁じる | 観点を変えて review し直させると別の note が湧いて収束しない — roundtrip が 1 回で閉まらなくなる |
| 4 | crate 移設 / rename / 分解構築 | **移設同型性** | rename similarity (git の %)、moved 部分の byte 温存、public path (`pub use` alias) 温存、下流利用の green 維持を要求 | 「移設のついで」の挙動変更が最も混入しやすい経路。similarity 98% の残り 2% を読ませる |
| 5 | 数値表現の置換 (float→integer、fixed-point 化、RNG 変更、hash 変更) | **分布 / 等価保存** | 置換前後の数学的同値の逆証明 — 閾値導出 (floor(p·2^N) 型)、丸め方向、境界 (0 / 1 / MAX)、overflow 中間型を点検させる | test green でも分布・境界が微妙に変わりうる。決定論 campaign では「ほぼ同じ」は回帰 — 保存則を式で確認させる |
| 6 | campaign の直列 workstream (他 stream への縫い目を stub で残す変更) | **seam 整合** | producer の stub seam 宣言 vs blueprint の workstream 分割表を照合。「本 AC を stub で誤魔化していないか」を問う | 直列分割では defer の正当性判定が gate の本丸 — seam が blueprint に無い独自判断なら scope 漏れの signal |
| 7 | infra / primitive / 機構の新設 | **production wire** | 新機構の caller chain を git grep で追跡させ、「production 経路に実配線されているか、consumer 0 の helper になっていないか」を問う | helper/test inflation antipattern (production consumer 0 の積み上げ) を gate で止める。「後で使う」は wire でない |
| 8 | security row (traversal / fail-open / sealed / 暗号) | **焦点分離 (Guardian 主担)** | bypass 敵対探索・防御配置は **Guardian** に置き、Observer には AC 品質・error 文言の作者可読性・fixture の判別力・lane 対称性を発注 | 同じ観点を両 gate に書くと片方が形骸化する。security の本丸は Guardian、Observer は品質面で二重化しない補完 |

**全 pattern 共通で prompt に入れるもの** (欠くと事故る):
- **Dock 検証済み事実の列挙 + 「treat as verified, do NOT re-run heavy builds」** — 書かないと gate が workspace build を再走して 30 分溶かす。
- 検証水準の宣言要求 (§A-2) と blocking / non-blocking の分離 (§A-5)。
- verdict marker の正準 path + bare token 契約 (§A-1)。

**Wanderer/design-review (DEC-076) は本表の外**: dispatch 前の設計 review は
`design_campaign_playbook.md` (census 接地 / citation spot-check / R-list) が正本 —
本表は「実装済み diff への gate」の選定表。

---

## 参照

- `pm_field_manual.md` — gate を dispatch する PM 側の決定表（§3 gate 依頼正準形）
- `worker_field_manual.md` — review 対象を作る producer 側の決定表
- `attended-gate-dispatch.md` — gate dispatch の完全 prompt template、report contract、high-stakes refuter
- `carabiners.md` — refuter (= `adversarial_verify` carabiner)・delta_gate・merge_review 等の任務形態語の正本（DEC-095）
- `templates/gate_verdict.md` — verdict marker 雛形（fail-closed parser contract を header に記載）
- Guardian / Observer SKILL + `references/` — verdict 意味 / review dimensions / redaction の正本
