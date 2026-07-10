# Gate-role field manual — Guardian / Observer 判断表 + Observer 視点集

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

## 参照

- `pm_field_manual.md` — gate を dispatch する PM 側の決定表（§3 gate 依頼正準形）
- `worker_field_manual.md` — review 対象を作る producer 側の決定表
- `attended-gate-dispatch.md` — gate dispatch の完全 prompt template、report contract、high-stakes refuter
- `templates/gate_verdict.md` — verdict marker 雛形（fail-closed parser contract を header に記載）
- Guardian / Observer SKILL + `references/` — verdict 意味 / review dimensions / redaction の正本
