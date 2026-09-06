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
5. **統合廃合は明示語彙で**: 吸収 (既定 = 内包 co-close、§3.4) / EVAPORATE (前提消滅、
   理由 1 行) / FREEZE (意図的凍結、解凍条件) / BLOCKED (blocker id)。黙って消さない —
   旧 id で検索する後続が迷子になる。判定述語と処置の正本は §3。
6. **status を信じない**: dispatch 前に land 痕跡 (`git log --grep <W-id>` / merge
   commit 実在) で row の状態を買い直す。row は書いた瞬間から stale になりうる。
7. **blocking 分類は user 意図で覆る**: 「engine gap で MVP-blocking」に見えても、
   user の reframe (「それは content で足りる」) で降格しうる。blocking 判定に迷う
   row は分類を確定させる質問を先に立てる — 分類ミスは queue 全体を歪める。

## 2. ブループリント化 (blueprint に固定するもの)

1. **実装 dispatch の前に blueprint**: 目安 = milestone 2 個分を draft で先行。
   draft は完璧でなくてよい — dispatch 時に確定していればよい。着手直前に書く
   blueprint は「実装の追認」になり review が機能しない。
2. **AC は番号化 + 検証 command 同梱**: role prompt にも gate prompt にも同じ
   番号で引用できる形。番号がないと re-gate で「どの所見がどの AC か」が迷子になる。
3. **defer は blueprint に明記**: 明記された defer は gate が OK とする / 明記のない
   欠落は gate 所見になる — この対称性が「gate と role の解釈揺れ」を消す。
4. **scope の母集合まで定義する**: 検証系 (census / audit / coverage) の blueprint は
   「何に対する全数か」の母集合定義を書く。母集合を role 任せにすると、検証対象と
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
9. **Lens selection**: blueprint の `## Lens selection` で role の判断焦点を
   設定 (または `[lenses.defaults]` に委ねる)。権限・書込 path は Lens で変えない。
10. **row AC と到達構成の差を close 時に照合する**: workstream row の AC は機能面
    (consumer/parity 等) に絞られがちで、blueprint の到達構成 (crate 構造・配置) より
    狭いことがある。row close = 到達構成の該当部分も満ちたか、を close 時に 1 行
    確認し、狭かったら残差を即 row 化する (実例: campaign 初回 workstream が
    in-place 実装で AC 充足 → crate 抽出が暗黙未達のまま ✅ 表示、外部 review で
    発覚)。**初回 workstream は型が未確立で特に狭くなりやすい** — 2 本目以降で型が
    確立したら初回に遡って照合する。

## 3. 起票・統廃合・dispatch 束ねの判定 doctrine

起票の入口判定から統廃合・dispatch 粒度までを 1 本の述語列で扱う常設規約。
origin = W-374 (統廃合 workflow 必須化) / W-375 (内包 co-close の型付き format)。

### 3.1 起票判断

**起票する = 3 条件の AND**: (1) 作業が残る (その場で完結しない)、(2) 今の lane の
scope 外、(3) 既存 open row と非重複。**起票しない 3 形**: AC 内 = rework で閉じる /
作業を要求しない観測 = 記録へ (tripwire として Notes に置く) / 既存 row の新事実 = 追記。
**起票時の義務 2 つを同時に果たす**: 重複照合 (label/keyword rg、照合語を残す) +
milestone 帰属。発見即起票 (§1-1) は不変 — 統廃合は起票 defer の理由にならない。

### 3.2 発見 lane との 4 分岐 (順に問う)

1. 発見 lane の **AC 内** → その lane の rework。
2. AC 外だが **lane の AC を塞ぐ blocker** → **別 row + lane は報告のみ (report,
   don't chase)**、chain は PM が組む。理由 = face 規律 + 交絡排除 (1 dispatch =
   1 機構に保ち、counterfactual と gate の因果判定を濁らせない)。
3. **既存 open row と同一機構** (§3.3 述語 1 と同じ問い) → 既存へ追記。
4. どれでもない → 新 row + milestone 帰属同時 + related link。

**分岐 2 の bundle 既定**: dispatch 1 本の固定費 (cold build + gate 席 ×2 + merge gate
の再全体 build 検査) は実在するので「blocker は常に別 dispatch」は過剰。
**既知 ∧ 同一 face の blocker は同一 dispatch に bundle し、commit 粒度で機構分離**する
(counterfactual の分離は commit 単位で保てる)。別 dispatch に割るのは 3 条件のみ:
(a) **逐次発見** (前の fix が走るまで次の壁が見えない)、(b) **face/設計権限跨ぎ**、
(c) **高 risk で gate の独立判定が要る**。直列 chain は `dispatch_prepare --reuse`
(WARM reuse) で warm worktree を継続し cold build 費を chain 内 1 回にする。
小粒 row (docs/低 risk) は最初から batch dispatch。

### 3.3 統廃合 = workflow の必須 step (2 段 + 述語 4 + 不変条件 4)

**2 段で機械的に回す**: 起票時 = 重複判定必須 (単票・安価、§3.1 の照合義務) /
**backlog 着手時 = 統廃合 sweep 必須** (一括・全体視 — queue 消化を始める前に open 全
row を吸収/moot/優先度改定の観点で 1 pass。単票検査では原理的に捕まらない
「溜まって初めて見える同一機構の別 face」を捕る)。

判定は列挙でなく述語で行う:

1. **吸収**: 「2 つの row を別々の lane が直したら、同じ code / 同じ設計裁定を触るか」
   → yes なら 1 つに束ねる (処置は §3.4)。**症状の類似は基準にしない** — 機構の同一性のみ。
2. **moot 化**: 「欠陥の対象がまだ実在するか」→ no なら AC から理由付きで除外
   (上位裁定・環境変化による前提消滅)。
3. **優先度改定**: 起票時の想定と実害の実測が乖離したら evidence 付きで改定。
4. **分割**: 1 row に別 lane/face の仕事が同居していたら割る。

不変条件 4: **dead-end 禁止** (吸収は必ず追える pointer を残す) / **AC union を
吸収先に明記** (内容は消さない、場所を 1 つにする) / **発見即起票は不変** /
**中止・吸収・moot 化・優先度改定は user へ表で報告** (黙って消さない。報告痕跡を
遷移 reason に含める)。

### 3.4 吸収の既定 = 内包 (co-close)

即 supersede しない。**両 row open のまま**内包 link を張り、**完了時に両方 close**
(evidence 共有) する。supersede は AC を仕事完了前に open view から消し、吸収先
cancel 時に関心事が宙吊りになるため、**supersede + replacement は「AC が既に完全
充足済み」の場合のみ**。

形 = **星型 1 段・連鎖禁止**: 親 (筆頭) 側 frontmatter `has = ["backlog:W-XXX", …]` が
**membership の正本 (親の 1 箇所のみ)**、子側は scalar 逆参照 1 個
`contained_by = "backlog:W-YYY"`。`has` を持つ row が別 row の `contained_by` 対象に
なるのは禁止 (入れ子不可)。`related` は**意味論なしの自由注記** — list 可、同一親の
子同士 (兄弟) 間も可。対称性・深さ・close 同時性の検査は has/contained_by にのみ掛かる。

**機構化 (W-375) 前の暫定形**: 親 body に `## 内包 (has): W-XXX` 節 + 相互 `related`、
子 body に「contained_by: W-YYY — close は親の landing と同時」を明記し、完了時に
PM が両方を手動 close する。

### 3.5 並列化と競合の 3 段判定 (2026-08-05 追補)

face 完全分離は必須でない。**危険な競合は textual でなく semantic** (実測: file 上無競合で
merge が通り全体 build で初めて衝突した class がある — 例: Rust で lane A の型変更 x lane B の新利用) — git conflict の有無で判定しない。

| Tier | 条件 | 処置 |
| :-- | :-- | :-- |
| A 自由並列 | 異 repo / module / file (例: Rust の crate 単位) | 制約なし |
| B 競合許容並列 | 同 file でも別 hunk・追記的。問い =「両変更が同じ行/symbol/不変条件を編集するか」= no | 進める。textual 解決は PM の統合 hygiene。dispatch_prepare --allow-conflict で宣言 |
| C 直列必須 | 同一 symbol/契約、型契約・閉語彙・registry 等の意味結合 (textual merge が通っても壊れる) | 直列。最後の網 = merge gate の trial-merge + 全体 build 検査 |

機構と 3 択 (Serialize/Split/Intentional parallel) の正本 = garelier-core
`role_subagent_dispatch.md` §2c (W-053) — 本節はその**選択述語** (Tier C/A/B が §2c の
3 択に対応) を与えるもので、機構を再定義しない。

agent:row の標準形 = **「1 row を work-split で 1.n sub-row に分割し、各 sub-row は 1 agent」**
(claim/branch/gate/evidence が row 単位のため帰属が 1:1 に落ちる)。並列度は分割で作り、
実行 cost は bundle (n sub-row→1 agent、§3.2) で抑える — 分割 (帳簿) と束ね (実行) は直交。
1 row へ N role を直接付けるのは不可 (claim 衝突・verdict bind 分裂・evidence 帰属崩れ)。
例外: dispatch 内部の一時 fan-out (role 自身の調査 helper sub) は row 分割不要。heavy build の直列化 (資源制約) は
競合と独立に残る。

### 3.5a 並列 / 直列の PM 判断 rubric (W-406)

`touches` の重複注記は**拒否ではなく PM の判断材料**である。判断主体は PM。迷ったら直列にする。

次のいずれかなら直列にする: (a) 前 lane の結果を見ないと次の設計または AC を確定できない、(b) 同じ symbol / 契約 / 不変条件 / registry を意味的に変更する、(c) 同時変更の合成を独立に gate 判定する必要がある高 risk の work。

直列条件 (b) の語彙は §3.5 の Tier C と対応する。同じ semantic coupling を二つの独立した doctrine として扱わない。

次のいずれかなら並列にできる: (d) 異なる module / file / 独立した設計面、(e) 同 file でも別 hunk への追記的な変更で同じ symbol・契約・不変条件を編集しない、(f) conflict が予想されても解決コストが待ち時間より小さく、PM が overlap を理解したうえで意図的な並列として記録し、base-track と merge conflict 解決を受け持つ。

判断材料は依存関係、touches の overlap 注記、共有する symbol / 契約 / 不変条件、変更が追加的か置換的か、各 lane の gate 範囲と合成 risk、heavy resource の直列化要件である。並列を選んでも merge gate の trial-merge と全体検査は省略しない。



### 3.5b 並列 wave の運用知見 (2026-08-12、8 lane 実戦から一般化)

§3.5a の並列/直列判定を「wave (複数 row の一斉並列)」として運用する時の実務則:

- **束ね方は file 域で決める**: 同一 file/機構域の row は 1 lane に束ねる (例: test infra 系 2 row、
  smoke flake 系 2 row)。lane 間で共有される巨大 test file への加算的変更は並列可 (§3.5a(e))。
- **解放 row を先頭に**: 他 lane の作業を制約する row (例: test-definition ceiling の拡張) は
  wave 先頭で land させると後続 lane の詰まりが消える。
- **merge は直列が律速**: N lane 並列でも studio 統合は 1 本ずつ (single-integrator 不変)。
  full CI が 10-15 分/本なら wave の総所要はほぼ「merge 数 × CI 時間」。lane 数を増やす価値は
  実装 wall-clock の圧縮にあり、統合は圧縮されない前提で計画する。
- **負荷と flake**: 並列 cargo/gate 負荷下では subprocess 系 smoke (child 120s timeout 級) が
  flake する。RED を見たら (1) fail した scenario を単独再走して flake/真 RED を判別、
  (2) heavy 並走中は merge/gate を直列化、(3) 恒久対策 = runner 側の RED 時単独再走 1 回。
- **claim/checkpoint の機械前提**: 並列 dispatch は「row が ready/active + active Checkpoint の
  backlog list に載っている + Current がその Checkpoint を参照」を全 lane 分先に揃える。
  claim は gate/rework の往復中に失効しうる — merge 直前に再取得 (steal) が定型。
- **worker の premise 検証には snapshot 注意**: checkout 内の control copy は worktree を切った
  時点の snapshot。row status の正本は live control 側 — stale copy を根拠に BLOCK しない/させない。
- **PM 側の未 commit を残さない**: claim/checkpoint 書込みで primary の control が dirty のまま
  merge を打つと gate の stash が CRLF 等で死ぬ。merge 発射前に control commit を挟む。

### 3.6 結線 — 統廃合 x 分割 x 束ね x 並列の一本化 (2026-08-05)

**統廃合は縦 (何を一緒にやるか)、並列化は横 (何を同時にやるか)。** pipeline:
起票 (3-AND+重複照合+milestone) → 統廃合 sweep (述語 4、co-close 親子 = 同一機構の確定 —
**同一機構は必ず同じ lane**、二重 dispatch の構造的禁止) → work-split (並列の単位を作る) →
bundle → Tier A/B/C (bundle 間の同時実行可否) →
実行 (1 bundle = 1 dispatch、直列 chain は WARM reuse) → landing (co-close 一括 close)。
queue gate (実 runtime gate PASS 等) は bundle でない直列点として queue に明記する。

**bundle の単位 = 依存の閉包** (2026-09-05、旧「n sub-row x 同 face → 1 agent、固定費を抑える」を置換)。
束を切る述語は face でも件数でもなく、**「分割の継ぎ目に何が生まれるか」**である。row A を先に land し
row B を後回しにすると、B の前提が A の中で stub / fallback / 旧 format 受理 / 「存在しないものの検出器」/
`TODO(次束)` として実装される — これは分割が作った産物であり、後で消す仕事 (legacy 削除 row) を
自分で起票することになる。判定:
1. 束候補の row 群で「B の存在を A が仮定する」辺を列挙する (依存 = A の code が B の型・場・契約を読む)。
2. 辺が跨ぐ分割は採らない。跨がない所でだけ切る (= 依存の閉包を 1 dispatch にする)。
3. 閉包が session 規模を超える場合も分割しない。代わりに blueprint に **1 row 1 commit + row 別 evidence**
   (gate 席が commit 単位で読める形) と **部分 land 条件** (残余が束の外の base 欠陥である時のみ、
   残余は理由付きで `[ ]` のまま) を書き、worker の session limit は resume で越える。
4. 閉包の外へ出す row は「束が land した後に初めて測れるもの」だけ (実走 evidence を前提とする AC 等)。
反証: 束を切った後に「fallback を残す」「互換層を足す」「無いものを検出する test を書く」のいずれかが
worker の register に現れたら、切り方が誤っていた signal — 束を統合し直す (row を増やさない)。
gate 席側の対 = `gate_field_manual.md` §A-4「継ぎ目の産物」。

### 3.7 merge 検証の test 種別 (2026-08-05 — Tier 並列の対)

**全て trial-merge した tree 上で走らせる** (branch 上の green は merge 起因欠陥を構造的に
見られない)。層別:
L1 型/build = project 全体の build/型検査 (textual 無競合の型衝突を捕る、merge gate の常設最低線。例: Rust `cargo check --workspace --all-targets --locked`) /
L2 静的 lint を error 扱いで (例: `clippy -- -D warnings`) / L3 unit 全走・中断させない (例: `--no-fail-fast`) /
L4 契約/統合 (module 間不変条件) / L5 一意性/閉集合 (census・台帳・exhaustive match =
両 lane の同一物追加を捕る) / L6 **counterfactual spot-check** (欠陥を戻して RED —
「merge が oracle を無歯化する」class の唯一の検出手段。競合面に接した test のみ) /
L7 決定論 (byte-parity replay・golden vector — sim/save/replay/network face で必須) /
L8 実 RUN gate (counter differential 等 — unit green は経路実行の証明にならない) /
L9 meta (test 数 census・lock/feature 差分 — 静かな削れの検出、毎 land)。
Tier B merge = L1-L3 / Tier C 隣接 = +L4-L6 / 決定論 face = +L7 / wiring face = +L8。
原則: **merge の危険は「両方とも正しい変更の合成」にあり、検証は合成後の tree でのみ意味を持つ**。

### 3.8 比例原則 — §3 自身への self-limit (2026-08-05、これで §3 は閉じる)

§3 の各手続きは**判断の省略形であって儀式ではない**。適用 cost が防ぐ損失の見込みを上回るなら
適用しない — この判定を §3 自身に適用する。常設は「起票時 grep+帰属」「着手時 sweep 1 回」
「merge gate L1」だけで、他は全て条件発火。過剰の兆候 = checklist の単調増加 /
L6-L8 の face 無関係な要求 / doctrine 追記が使用実績より速い。兆候が出たら**削る変更を先に**。
本節以降、§3 への追記は「既存節の削減・置換」を伴う場合のみ可。

## 4. 委譲表

| 内容 | 正本 |
| --- | --- |
| blueprint の書式・review sign-off 手順 | `blueprint-authoring.md` §4 |
| milestone / roadmap の構成 | `milestones-roadmap.md` §5 |
| dispatch prompt の書き方 (model 別 / 役別) | `../../garelier-core/references/dispatch_prompt_craft.md` |
| 設計 campaign の回し方 (多段 review / 残件化→triage) | `../../garelier-core/references/design_campaign_playbook.md` |
