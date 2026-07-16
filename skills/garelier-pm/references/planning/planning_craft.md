# Planning craft — バックログ化とブループリント化の判断ポイント

row / blueprint の**書式**は `blueprint-authoring.md` と backlog template が正本。
本書はその上の**中身の craft** — 何を row にし、どう並べ、blueprint に何を固定
すると手戻りが消えるか。実戦由来 (target project 2026-06〜07 の 285 row triage /
DEC-039 campaign / gate HOLD 回収 trail から一般化)。

## 1. バックログ化 (row の作り方)

1. **発見即起票**: 発見した turn 内に row を書く。「後でまとめて起票」も「起票したと
   報告して row 未記載」も禁止 — 起票 claim と row 実在の乖離は検出 lint の対象。
2. **open-only 規律**: 完了 row は完了と同じ commit で削除。履歴は git が持つ。
   「済」印の row を残すと次の PM が二重着手する。
3. **row 品質の 3 点**: (a) outcome は ≤25 語で「何がどうなったら閉じるか」、
   (b) AC は**判定可能** (test 名 / 数値 bound / 実測 command) — 「改善する」は AC に
   ならない、(c) 現象由来の row は**現象 verbatim + 再現 command** を残す (着手時の
   premise 反証が機械確認できる形)。
4. **並び = 計画 queue が正**: 空き lane は新規や直近発見でなく**計画済み queue の
   head** に充てる (recency jump 禁止)。risk-first とは「planned scope 内の riskiest」
   であり、新規 item の优先ではない。新規は proper position に file するだけ。
5. **統合廃合は明示語彙で**: 吸収 (吸収先 row に旧 id を記録) / EVAPORATE (前提消滅、
   理由 1 行) / FREEZE (意図的凍結、解凍条件) / BLOCKED (blocker id)。黙って消さない —
   旧 id で検索する後続が迷子になる。
6. **status を信じない**: dispatch 前に land 痕跡 (`git log --grep <W-id>` / merge
   commit 実在) で row の状態を買い直す。row は書いた瞬間から stale になりうる。
7. **blocking 分類は user 意図で覆る**: 「engine gap で MVP-blocking」に見えても、
   user の reframe (「それは content で足りる」) で降格しうる。blocking 判定に迷う
   row は分類を確定させる質問を先に立てる — 分類ミスは queue 全体を歪める。

## 2. ブループリント化 (blueprint に固定するもの)

1. **実装 dispatch の前に blueprint**: 目安 = milestone 2 個分を draft で先行。
   draft は完璧でなくてよい — dispatch 時に確定していればよい。着手直前に書く
   blueprint は「実装の追認」になり review が機能しない。
2. **AC は番号化 + 検証 command 同梱**: producer prompt にも gate prompt にも同じ
   番号で引用できる形。番号がないと re-gate で「どの所見がどの AC か」が迷子になる。
3. **defer は blueprint に明記**: 明記された defer は gate が OK とする / 明記のない
   欠落は gate 所見になる — この対称性が「gate と producer の解釈揺れ」を消す。
4. **scope の母集合まで定義する**: 検証系 (census / audit / coverage) の blueprint は
   「何に対する全数か」の母集合定義を書く。母集合を producer 任せにすると、検証対象と
   検証入力が同一になる**恒真検証** (常に PASS で何も検出しない) を gate まで運んで
   しまう (実例: hash 入力と同じ集合を census 母集合にして HOLD)。
5. **oracle 先行の原則**: 壊す (再構築・削除・移行) campaign は、先に oracle
   (golden / determinism hash / census baseline) を固定する phase を独立させ、
   そこに hard gate を置いてから構築 phase に入る。oracle が無いままの再構築は
   「動いているように見える」しか言えない。
6. **破壊的変更は 1 回に束ねる**: save format bump / schema 変更級は同乗できる変更を
   blueprint 段階で列挙し、bump 回数を 1 に畳む。「byte-neutral 実証済で同乗物なし」も
   blueprint に書く (同乗判断の trail)。
7. **code symbol は実在確認か (仮称) tag**: 非実在 symbol を実在の顔で書くと後続が
   誤読して drift 修正が複数 round 再発する。`git grep` で確認するか (仮称) を付ける。
8. **high-stakes は dispatch 前 review (DEC-076)**: migration / protected path /
   新 top-level key / 大 diff / architecture 変更は Wanderer→Observer review を通し
   `## Review sign-off` を埋めてから dispatch。trivial は skip — 日常 dispatch への
   税ではない。
9. **Lens selection**: blueprint の `## Lens selection` で producer の判断焦点を
   設定 (または `[lenses.defaults]` に委ねる)。権限・書込 path は Lens で変えない。
10. **row AC と到達構成の差を close 時に照合する**: workstream row の AC は機能面
    (consumer/parity 等) に絞られがちで、blueprint の到達構成 (crate 構造・配置) より
    狭いことがある。row close = 到達構成の該当部分も満ちたか、を close 時に 1 行
    確認し、狭かったら残差を即 row 化する (実例: campaign 初回 workstream が
    in-place 実装で AC 充足 → crate 抽出が暗黙未達のまま ✅ 表示、外部 review で
    発覚)。**初回 workstream は型が未確立で特に狭くなりやすい** — 2 本目以降で型が
    確立したら初回に遡って照合する。

## 3. 委譲表

| 内容 | 正本 |
| --- | --- |
| blueprint の書式・review sign-off 手順 | `blueprint-authoring.md` §4 |
| milestone / roadmap の構成 | `milestones-roadmap.md` §5 |
| dispatch prompt の書き方 (model 別 / 役別) | `../../garelier-core/references/dispatch_prompt_craft.md` |
| 設計 campaign の回し方 (多段 review / 残件化→triage) | `../../garelier-core/references/design_campaign_playbook.md` |
