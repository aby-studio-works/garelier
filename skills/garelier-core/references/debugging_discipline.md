# Debugging discipline — producer 視点のバグ修正規律

バグ・drift・regression を直す producer（Worker / Smith / Artisan）が、
推測で外して round を重ねないための read-on-demand リファレンス。

PM 視点の同じ規律は `pm_playbook.md` §9（推測 fix 禁止 / verify-before-dispatch）に
ある — そちらは **PM が dispatch する前に真因を evidence で確定する**話。本 file は
**assignment を受け取った producer が手元で直すときの手順**で、棲み分ける。重複は
書かない。「No internal defensive layers」（対象 project の設計原則）とも同旨で、症状を
guard で黙らせるのでなく真因を直す。

---

## 1. 4 phase 規律 — 観察 → 仮説 → 検証 → 修正

バグは次の 4 phase を順に踏む。phase を飛ばして「多分こうだろう」で修正に進まない。

1. **観察（現象を機械的 evidence に）.** 計装 log / 再現手順で、現象を再現可能・
   観測可能にする。「たぶんここが nil」で次に進まず、log を 1 本足して *実際に*
   何が起きているかを見る。再現手順（どの入力で・どの frame で・どの値が出るか）を
   固定する。ここで真因が一撃で見えることが多い。

2. **仮説（複数候補を列挙）.** 観察した evidence から、原因候補を **複数** 挙げる。
   1 個で決め打ちしない — 最初に思いついた候補が真因とは限らない。各候補は
   「もしこれが原因なら、X という観測が出るはず」の形で反証可能に書く。

3. **検証（各仮説を最小 command / test で反証）.** 候補を 1 つずつ、最小の
   command / test で潰す。log 追加・値 dump・境界値入力など、その候補だけを
   切り分ける最小手を打つ。推測で対策を当てて 2 周するより、切り分け 1 手のほうが速い。
   残った 1 つが真因。

4. **修正（確定した根本原因のみ直す）.** 検証で確定した真因 **だけ** を直す。
   作業中に気づいた周辺の「ついで修正」は **scope 外** として report に回す
   （silent に広げない）。真因と無関係な変更を同じ commit に混ぜない。

---

## 2. bug-fix TDD — 再現 test を先に書いて RED → fix → GREEN

bug class の assignment は **再現 test first** を既定とする。

1. 真因の現象を落とす **再現 test を先に書き**、それが **RED（失敗）**することを確認する
   （test が現象を正しく捉えている証拠）。
2. 修正を入れて **GREEN（通過）**にする。
3. この pin test が **regression 防止の正本**になる — 同じバグが再発したら test が落ちる。

**代替（実機視覚系など再現 test が書けない class）.** 実機描画・GPU 出力・
タイミング依存など、test harness で再現 test を書けない class は、**計装 log の
before/after** を evidence として代替してよい。「修正前はこの値/この描画、修正後は
こう」を report に残す。代替する場合は「再現 test 不可の理由」を明記する。

---

## 3. 禁止形

次の 3 つは「直したつもりで真因が残る」ので禁止。

- **推測 fix（evidence なしの修正）.** 観察 phase を飛ばし、log / test の
  evidence なしに「たぶんこれ」で修正を入れる。真因が別だと現象が別の顔で再発する。
- **症状抑え込み（root cause でなく guard で黙らせる）.** 落ちる箇所に
  early-return / null guard / try-catch を足して現象を消すだけで、なぜ不正な値が
  来たのかを直さない。「No internal defensive layers」原則に反する —
  内部に防御層を積むのでなく真因を直し、防御は cooker / test 境界に置く。
  （真因が「不正入力が入る」なら、入力境界の validation を直すのは症状抑え込みでは
  なく真因修正。「不正入力が入っても落ちないよう黙らせる」だけが禁止形。）
- **shotgun fix（3 仮説以上を同時に直す）.** 検証で 1 つに絞らず、当たりそうな箇所を
  まとめて複数直す。どれが効いたか分からず、無関係な変更で新しいバグを埋め込む。
  1 phase = 1 真因。

---

## 4. 実例（対比）

- **一撃型.** 現象「特定 tick で値が二重加算される」。観察 phase で疑わしい経路に
  log を 1 本入れ、加算 system が同 frame で 2 回走っていることを一撃で確定。
  仮説は「重複 schedule 登録」1 本に絞れ、検証（system 登録箇所の grep）で確定、
  1 箇所（重複登録の除去）を直し、再現 test（同 tick で加算 1 回を assert）を
  RED → GREEN。1 round で closure。
- **外し型（禁止形）.** 同じ現象を「たぶん初期値のバグ」と推測で決め打ちし、初期値を
  いじって外し（round 1）、次に「加算式のバグ」と推測して式を変えて外し（round 2）、
  さらに guard を足して二重加算を黙らせた（round 3、症状抑え込み — 真因の重複
  schedule は残り、別 system で再発）。観察 log 1 本を先に入れていれば round 1 で
  終わっていた。

一般化: **見えない挙動は log 計装を 1 本足して一撃で確定させる。**推測で外して
round を重ねるより速く、pin test が残って regression も止まる。

---

## 5. 手元 verify の resilience — stall と偽陽性の罠を避ける

修正の gate は通ったが、その先の **実機 verify**（アプリ起動・GPU 描画・replay・soak）で
producer が繰り返し dormant 化する / verify の合否を誤読する、を避ける手元規律。

- **gate GREEN の成果は verify の前に commit する.** scoped gate（`cargo check -p … +
  test -p …`）が通ったら **先に workbench branch へ commit**（`worker_finalize.ts`）し、
  それから重い実機 verify を回す。workbench commit は merge でない（Dock が gate する）ので
  早期 commit は安全で、flaky な verify 中に stall / crash しても gate を通った実装を失わない。
  合否を出す gate 自体は budget 内なら foreground（DEC-073）。長い **観測系** verify は whole
  command のまま durable ledger + single-flight broker に載せる。個別 waiter や同一 turn polling
  を作らず、FINISHED result を読んで exact attempt を ACK する。

- **task wrapper / script の exit code を鵜呑みにしない.** verify を wrapper 越しに走らせると、
  末尾の `echo done` 等が cargo/build の exit 1 を隠し wrapper 全体が exit 0 に見えることがある
  （実例: 末尾 echo が cargo の失敗を握り潰した）。**cargo/build 自体の exit code と log 末尾の
  両方**を読む。`set -e` の無い script や `cmd; echo ok` の形は特に危険 — `cmd && echo ok` か
  `cmd || exit 1` に直すか、生の exit status を確認する。「gate 通った」を wrapper の 0 で
  即断しない。

- **fresh worktree の生成物前提を確認する.** 新しい worktree / clean checkout で verify が
  「機能バグ」に見えたら、まず **生成物（cooked artifact / baked binary / generated file）が
  在るか**を疑う。例: `--validate-only` は検証のみで cooked artifact を **生成しない** ので、
  その出力を前提にした後段 verify は「壊れている」でなく「入力が無い」。真因を「機能バグ」と
  誤断して推測 fix（§3 禁止形）に走る前に、precondition（生成 step を先に走らせたか）を
  §1 の観察 phase で確認する。

---

## 6. 外部 platform 挙動は公式 source で確定する — 「消費している物」規律

修正・設計が **外部 platform/tool（harness / Claude Code / OS / 第三者 lib）の挙動**に
依存するとき、その挙動を **repo 内の観測だけで確定扱いしない**。判定 test は
**「この主張は我々が *作った* 物についてか、*消費している* 物についてか？」** — 後者なら
**確定前に公式文書で verify し、原文引用 + URL を fix report / DEC に残す**。自 repo の
docstring・コメントは spec でなく **観測**なので、根拠に引くなら `[in-repo observation]`
と label して「公式で裏を取っていない」ことを明示する（tag 定義は `document_standards.md`
§Source tags）。code symbol に「引用前に git grep」規約があるのと同型で、platform 挙動にも
「確定前に公式 source」を課す。

- **verify の道具（reachability）** — Claude Code の挙動疑問は **`claude-code-guide`
  agent**、その他外部 platform は **WebSearch / WebFetch** で公式 source に当たる。道具は
  在るので「in-context で足りている」感覚で飛ばさない。
- **非 mandatory** — 日常の小変更に公式確認を課さない。**platform 挙動に設計判断が
  依存する**ときだけ。§3 の推測 fix と同根で、消費物の主張は観測でなく公式 source で固定する。

**根拠(実例).** Bash timeout / subagent 継続性という Claude Code の挙動を repo 内
docstring + 観測だけで確定扱いし、W-077 の対策を 2 回誤設計した。公式確認で初めて
host timeout の official default/read-only context が判明した。Garelier は設定値を変更・提案・
child env 注入しない。precedent = `role_subagent_dispatch.md`
§6 が Agent Teams の挙動を `[official spec]` + URL + 検証日で書いている。

## 参照

- `pm_playbook.md` §9 — PM 視点の verify-before-dispatch（dispatch 前の真因確定）。
  本 file は producer 視点（受領後の手元修正）で棲み分ける。
- `pm_playbook.md` §5 — merge conflict の producer 解決（真因確定と同じく、code を
  持つ producer が自力で解く）。
- `../../garelier-worker/SKILL.md` / `../../garelier-smith/SKILL.md` §Boundaries —
  本規律の hot rule 1 行 + 本 file への pointer。
- `../document_standards.md` §Source tags — §6 の platform 主張に付ける 4 tag
  （`[official spec]` / `[in-repo observation]` / `[session measurement]` / `[inference]`）の定義。
- 対象 project の `CLAUDE.md` / memory `feedback-mechanism-fix-and-class-audit` — 「1 件見たら
  class 全体を監査」。同種バグは preventive / detective の仕組みで是正し横断監査する。
