# Gate-role field manual — Guardian / Observer 判断表 + Observer 視点集 + PM の review pattern 選定表

merge gate を担う **Guardian / Observer** の subagent（opus / sonnet）が、判断で詰まらず
同水準の review を返すための決定表・checklist。§A が gate 役共通の手順、§B が Observer が
独立レビューの仮説を正しく立てるための視点集。verdict 意味・redaction・scope の正本は
各 role SKILL（`garelier-guardian` / `garelier-observer`）で、ここはその実行 view。

**使い方:** 判定は必ず file:line / diff evidence に接地する（DEC-088、bare な形容詞は不可）。
gate 役は verdict を**自分で書く**（DEC-090 — PM は書かない）。read-on-demand。

審査前に [`blueprint-output-contract.md`](blueprint-output-contract.md) を適用する。
blueprint の出力定義と成果物/verdict の適合、欠落時の fail-closed 判定はこの共通正本が持つ。

---

## §A. gate 役共通の手順（Guardian / Observer）

### A-0. prompt の blueprint 複製を拒否する（審査開始前、W-451）

gate prompt は dispatch 固有の事実を運ぶ envelope であって、審査基準の正本ではない。
最初に prompt が指す blueprint を読む。

**閉じているのは機構専有 2 見出しだけ (W-708 / DEC-100 裁定 2 の段 0)。**
`## Role source pointers` と `## Task` は機構が構成する側の見出しで、
**PM が書く入力 (`gate_prompt_input` / `task_file`) に現れたら 2 本とも拒否**する。
構成後の gate prompt 側で**欠落を拒否するのは `## Role source pointers` の 1 本だけ**
(`COMPOSED_REQUIRED_SECTION_HEADINGS`) — `## Task` は task file を包む envelope の見出しで、
`dispatch_prepare --task-file` の経路にしか現れず、attended seat が `--prompt-file` の
PM tail を append して作る prompt には存在しないため、2 本とも要求すると attended 経路を
false-deny する。**それ以外の `##` 見出しは自由**である
(`## QG-9 gate step` / `## Notes` / `## 経緯` はいずれも拒否しない)。
旧形は下表を閉じた allowlist として使い、表に無い見出しを 1 つでも refuse していたが、
その refuse が捕まえた blueprint 複製は 0 件で、dispatch を 1 round 押し戻すだけだった。

次の表は機構が生成する **canonical な section 集合**であり、`prompt_section_contract.ts`
の配列・field contract と同順の対応表である (CI が片側だけの変更を拒否する)。
**表に無い見出しの追加は違反ではない** — 表は「機構が何を書くか」を宣言する。
field 形 (`## Review SHA` / `## Dock gate`) だけは、その見出しが在る時に必ず検査される。
field 形の実行正本は code 側の contract id に 1 つだけ置き、この marker
区間は同じ id を参照する。正規表現を doc と code に二重実装しない。

機構が構成した gate prompt の canonical `##` 集合:

<!-- prompt-section-contract:gate_prompt:start -->
| code heading | A-0 で運ぶ情報 | field contract id |
| :-- | :-- | :-- |
| `## Role source pointers` | 機構が選んだ blueprint path / Lens pack / Lens group。機構生成専用 | `none` |
| `## Task` | 検査済み task file 本文の envelope。機構生成専用 | `none` |
| `## Seat` | 席名（`ga-<role>-<slug>`） | `none` |
| `## Dispatch` | dispatch id / branch / tip SHA / base SHA / checkout path | `none` |
| `## Blueprint` | blueprint path と「これが正本」の 1 行 | `none` |
| `## Output` | verdict file（または result file）の出力先 path | `none` |
| `## Review SHA` | `review_sha: <40 hex>` を単独行で 1 つ以上 | `review_sha_40_hex_line` |
| `## Verdict` | その role が選べる verdict token | `none` |
| `## Dock gate` | Dock 代行 gate の結果（log path + `GREEN` / `RED`） | `dock_gate_log_path_and_status` |
<!-- prompt-section-contract:gate_prompt:end -->

attended 経路で PM が与える gate prompt **入力**の canonical `##` 集合。機構生成専用の
`Role source pointers` / `Task` は入力で拒否し、構成後の surface だけで許可する
(入力側ではこの 2 見出しが唯一の拒否条件。他の見出しは自由に足してよい。
構成後の欠落検査は `Role source pointers` のみ — 上の注記を参照):

<!-- prompt-section-contract:gate_prompt_input:start -->
| code heading | A-0 で運ぶ情報 | field contract id |
| :-- | :-- | :-- |
| `## Seat` | 席名（`ga-<role>-<slug>`） | `none` |
| `## Dispatch` | dispatch id / branch / tip SHA / base SHA / checkout path | `none` |
| `## Blueprint` | blueprint path と「これが正本」の 1 行 | `none` |
| `## Output` | verdict file（または result file）の出力先 path | `none` |
| `## Review SHA` | `review_sha: <40 hex>` を単独行で 1 つ以上 | `review_sha_40_hex_line` |
| `## Verdict` | その role が選べる verdict token | `none` |
| `## Dock gate` | Dock 代行 gate の結果（log path + `GREEN` / `RED`） | `dock_gate_log_path_and_status` |
<!-- prompt-section-contract:gate_prompt_input:end -->

task file の canonical `##` 集合:

<!-- prompt-section-contract:task_file:start -->
| code heading | A-0 で運ぶ情報 | field contract id |
| :-- | :-- | :-- |
| `## Seat` | 席名（`ga-<role>-<slug>`） | `none` |
| `## Dispatch` | dispatch id / branch / tip SHA / base SHA / checkout path | `none` |
| `## Blueprint` | blueprint path と「これが正本」の 1 行 | `none` |
| `## Output` | verdict file（または result file）の出力先 path | `none` |
| `## Review SHA` | `review_sha: <40 hex>` を単独行で 1 つ以上 | `review_sha_40_hex_line` |
| `## Verdict` | その role が選べる verdict token | `none` |
| `## Dock gate` | Dock 代行 gate の結果（log path + `GREEN` / `RED`） | `dock_gate_log_path_and_status` |
| `## Dispatch-specific facts` | base-track / 並列 lane / gate 代行方式 / ledger の事実 | `none` |
<!-- prompt-section-contract:task_file:end -->

`dispatch_prepare` は検査済み task file を `## Task` の下へ置く時、その `##` を `###` に
一段下げる。本文も見出しも捨てず、task file 専用の `## Dispatch-specific facts` を gate
prompt の top-level `##` へ移さない。

**機械検査が止めるのは機構専有 2 見出しと field 形だけ**になった (W-708)。
blueprint の背景・経緯・設計判断・Gate 重点、role 主張の要約、blueprint に無い判定基準を
prompt が運んでいることは**依然として prompt contract 違反**だが、その判定は
見出し名ではなく**中身**で行う — gate 役が下の手順で受け手側 fail-closed backstop として
処理する。

違反時は次の順で処理する:

1. prompt の複製本文や prompt にしかない判定基準を審査基準として採用しない。
2. blueprint を正本として diff を審査し、通常の finding も失わない。
3. prompt の違反節ごとに blueprint と照合し、欠落 / 追加 / 差異を file:line evidence で列挙する。
4. full canonical report と verdict marker の `## Evidence` の両方に
   「prompt が blueprint を複製した」事実と差分を書く。prompt にしかない基準は
   「blueprint に追加すべき（今回は不採用）」と明記する。
5. gate request 自体を **`BLOCK`** にする。`PASS_WITH_NOTES` で通してはならない。

機械検査 (機構専有 2 見出し + field 形) が dispatch 前に止めるのが第 1 防線で、
この手順は**内容による複製判定**の唯一の席である。違反がなければ A-1 以降へ進む。

### A-1. report は正準 path + standalone canonical fields（必須）

verdict marker を、branch slug 由来の正準 path に書く（短縮名は auto-read が拾えない、W-020）:

```
__garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
__garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md
```

**role は emitter が付ける。`--slug` には branch slug をそのまま渡す** — 既に role で
終わる slug を渡すと導出 path が `…-<role>-<role>.md` になり、席が 2 つの候補から
選ぶことになる。`dispatch_prepare` は **spawn 時に fail-closed** で拒否する:
gate prompt がその席自身の role の verdict path を 2 つ以上名指ししていると
spawn しない（他 role の verdict を読む行 — Observer が Guardian の verdict を読む等 —
は正当なので対象外）。producer と同じ slug で gate 席を出しても重複扱いにはならない
（in-flight 判定の key は `(role, slug)`）ので、gate 席のための rename は要らない。
判定は provider に依らず同一。

marker と canonical role report の両方を、**`+++` TOML front matter で開く**。機械が読む値は
すべて front matter の `[section]` / `[[array]]` table の下に置き、top-level の bare key は作らない
（`templates/gate_verdict.md` が雛形）。散文は閉じ `+++` の下に書く。**値は 1 つも散文から
採らない**が、散文が読まれない訳ではない — 退役形の `uncovered_dimension:` /
`uncovered_cause:` / `uncovered_tracking_row:` / `alternate_confidence_basis:` で始まる行が
あると、`[[uncovered]]` table の有無に関わらず verdict は明示 reject される（DEC-046。
table と散文の混在だけが「parser には完全、書き手には申告済み」に見えるため）。

```toml
+++
[verdict]
result = 'PASS_WITH_NOTES'
review_sha = '<40..64 文字の lowercase hex SHA>'
+++
```

**値は TOML string なので、括弧・backtick・引用符・改行はただの文字**である。parser に合わせて
finding を言い換える必要は無い（複数行は `'''...'''`）。同じ節を 3 箇所へ重複させる旧 grammar
（header の `verdict:` 行 + `## Verdict` 見出し + その直下の bare token）と、fence 認識の行走査、
および strict parse が拒否した report を拾い直す互換 parser は**すべて退役した** — 互換 parser が
在る限り strict 判定は助言でしかなく、canonical grammar が拒否した report が merge を通せた。

**ただし marker には読み手が 2 つあり、同じ面を読まない（W-668 / F-20、2026-09-02 実測）。**
`merge_land.ts`（`merge_gate_parse.ts` 経由）は front matter の `[verdict] result` だけを読み、
`contract_check.ts --gate` は `## Verdict` 見出しとその直下の bare token を要求する。
**両方を書く**のが唯一の正しい形で、片方だけの marker は他方が refuse する:

- front matter だけ → `contract_check --gate` が `verdict_section_missing … has no '## Verdict' section`
- `## Verdict` 節だけ → `merge_land` が `present but MALFORMED` として verdict なし扱い

退役したのは「散文の `verdict:` header 行」と互換 parser であって、`## Verdict` 節ではない。
`templates/gate_verdict.md` は両面を持つ雛形なので、**雛形をそのまま埋めれば両方を満たす**。
register 契約の全数と件数は `worker_field_manual.md` §5b-1 が正本。

`{{}}` menu / typo（`PASSED`）/ 截断 / field 不在 / `review_sha` 不在は **null = fail-closed**
（PASS にならない）。**front matter が無い旧形式は「読めなかった」として明示 reject される** —
「verdict が無い」と混同されない。merge request 前に `merge_gate_parse.ts` と同じ parser で
report を検証する。full 報告（findings + evidence）は role の canonical report
（`guardian_report.md` / `report.md`）に、marker は machine-read 用の compact token に、と
2 本立てで書く。marker は最終 message の**前**に書く。

**二重 suffix 自体は verdict を失わせない**（W-634 の実測） — writer と reader は同じ
`seatReportPath` から path を導くので、二重でも両者は一致する（実測 = 二重 file 425 件、
うち 422 件は二重 path にしか存在せず、それでも読めている）。実害は
**prompt が emitter 由来の path と手書きの path を 2 つ名指し、席が選ぶ**形の方であり、
上の spawn 時 fail-closed が拒否しているのはまさにその形である（file 名ではなく prompt を見る）。

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

TypeScript driver の test runner は `bun test` が canonical。`bun run test` を同義扱い
せず、まして `bun run <anything>` を包括 allow しない。package script 経由が本当に
必要な project は、その exact command を dispatcher が作る permission record に宣言する。

- **PM の運用**: managed detached gate 席は `dispatch_prepare.ts` で発行する。
  dispatcher は project fact pack の quality-gate command を同じ経路で permission record に積む。
  `attended_record.ts` は `dispatch_prepare.ts` / `workspace_isolate.ts` と明示
  PM-directed lightweight 例外の command-guard permission-record writer であり、managed detached
  gate 席の入口ではない。明示 attended 例外で `--quality-gate <cmd>`（繰返し可）を記録した場合も、
  command_guard は record 記載の command と
  **全文 verbatim 一致**したものだけ allow する（`isDeclaredWholeCommand`）。この allow は
  **profile 非依存**（declared list を持つ任意 profile に適用）だが、実運用で list を積むのは
  gate 席だけ（他 profile は record に verify list を持たない）。絞っても forge 面は閉じず、
  deny 床が全 profile を束縛するため実装は profile で絞らない（Observer 裁定 2026-07-20）。
- **laundering 防止**: 記載外 command は従来どおり deny。前方一致や記載 command への追記
  （`<listed> && rm -rf x`）は verbatim 不一致で不採用、かつ deny 床（gate_mutation / egress /
  delete / secret / force / process_kill）は**全 profile を束縛**し、strictest-wins で常に先勝ち
  する（record に `git push` を積んでも egress deny が勝つ）。だから profile で絞らなくても
  declared allow が deny 床を破ることはない。
- **gate 席側**: 検証が deny で止まったら、その command が record の `--quality-gate` に verbatim で
  積まれているかを PM に確認（register で「<command> が gate profile deny、quality_gate 未記載」と
  escalate）。gate 席が任意 script を勝手に走らせる緩和ではない。
- **宣言なしでも席から直接届く read-only class**（W-382 / W-517 / W-519、2026-09-03）:
  `cargo tree` / `cargo metadata` / `cargo pkgid` / `cargo locate-project` /
  `cargo verify-project` / `cargo read-manifest` / `cargo --version`（**書込 subcommand を持たない
  cargo 問合せ**という class であって列挙ではない — `cargo generate-lockfile` / `cargo install` /
  `cargo build --out-dir` は class の外で deny のまま）。
  **head が合っても flag tail は vouch されない**（2026-09-03）: `--manifest-path` /
  `--target-dir` / `--out-dir` は **operand が path fence を通る**ので席内なら allow・
  席外なら deny（cargo は**指された manifest の隣に** `Cargo.lock` を書く）、
  `--config` と `-Z` は**走らせる program を選べる**ので deny のまま (`-Z` は
  `-Zunstable-options` のような**値連結形も**含めて全綴り)、`git merge-tree`（`--write-tree` は
  object store にしか書かず ref も index も動かさない。`git merge` は class 外）、全 arm が
  read-only な `case … esac` chain（`if …; then …; fi` と同格。label に `$(…)` を持つ形と、
  1 つでも非 read-only な arm を持つ形は deny のまま）、および
  **env-assignment prefix 付きの同一 command**（`FOO="x" bun test f.test.ts` は prefix 無しと
  同じ判定）。**見逃されるのは肯定形 allowlist に載る名前だけ**（2026-09-03、
  `GARELIER_TEST_SCENARIO_FILTER` / `RUST_LOG` / `RUST_BACKTRACE` / `NO_COLOR` /
  `FORCE_COLOR` / `CLICOLOR` / `CLICOLOR_FORCE` / `TERM` / `CI`）。それ以外は
  `HOME` / `XDG_CONFIG_HOME` / `CARGO_HOME` / `RIPGREP_CONFIG_PATH` のような
  **config 探索先を変える名前**も含めて opaque のまま deny — deny 列挙では漏れるため。
  `case` の arm は `pattern) cmd` 綴りのみで、**label は case pattern**（1 語、または
  `|` 区切りの語）である必要がある（`(pattern)` は separator 分割後 subshell と同形になるため
  受理せず、`rm -rf /tmp/zzz)` のように label が command の形も、`rm)` / `sh)` / `npm)` / `a)` のように
  **body が続かない形**も受理しない）。
  境界を締めた副作用で一度落ちた read-only plumbing（`git diff-tree` / `diff-index` /
  `diff-files` / `show-ref` / `show-branch` / `show-index`）は肯定形 list の member として戻している。
- **素の `gitleaks` は今も deny**。deny message が正しい経路（`bun <path>/guardian_scan.ts …`、
  availability は `--probe-gitleaks`、直接起動は W-297 canonical argv のみ）を名指すので、
  「scanner が使えない」と読み替えて degraded mode に入らないこと（A-7-1 の閉じた規則）。
- **deny が席の位置由来である場合**（W-575 / W-545）: fail-closed deny の reason に
  `位置の由来: dispatch record (<path>) の worktree = …` か `位置の由来: session cwd (…)` が
  付く。後者は席の record が解決できていない signal — shell tool（Bash / PowerShell）を
  変えても同じ deny になるので、tool を変えて再試行するのではなく register で escalate する。

### A-3. test の tautology 検査

追加/変更された test を鵜呑みにせず、**判別力**を検査する:

- 「この test を**旧 code に当てたら fail するか**」を問う（逆証明）。
- identifier rename だけ / no-op でも通る test = **tautology**。指摘する（bug を捕まえない test は
  緑でも価値ゼロ）。可能なら「旧実装 or 故意の逆変更で RED になるか」を実際に試して書く。
- aggregate の追加 oracle は同じ変更で scenario を統合・削除し、`scenario_count` を純増させない。
  実測 `wall_clock_s` は before/after の報告値であって単独の合否条件ではない。同名 test の
  focused/full 二重実行は project-declared register supersession で実行前に除く。focused result は
  candidate full CI へ carry せず、full CI の canonical inventory は post-land Smith batch が一度だけ所有する。

### A-3b. 分母検査 — census は「何件」でなく「何を対象に何件」（2026-08-15、1 日 8 例）

**検出器の出力は分母を伴わなければ evidence にならない。** 「N 件 clean」は主張であって
証拠ではない。**「M を対象に走査して N 件」**の M が無い報告は、gate 席が受け取らない。

個々の検査が正しくても、走った宇宙が違えば結論は偽になる。2026-08-15 に 1 日で 8 例:
scanner の空分母 / census が seed grep 由来 / role の ledger 自己申告 / 触った file
だけの census / gate 記録が commit を指さない / path census が 1 拡張子だけ / 否定主張の
未検証 / 負荷測定が 1 channel だけ。**どれも「嘘」ではなく「別の宇宙の真」だった。**

gate 席は次を実行する:

1. **分母を自分で数え直す。** role が自分の作業について出した census は、
   **その席が触った範囲**の値であって全体の値ではない。同じ規則を再実装して突き合わせる
   （command をそのまま走らせるのでなく、規則から再導出すると宇宙の違いが出る）。
2. **`0` を 2 通りに分けて読む。** 「対象を走査して 0 件」と「対象を解決できず 0 件」は
   別物。`count` だけを見ると区別できない。scanner の `scan_state` / `coverage` /
   `failure` を必ず併読し、**分母が空の PASS を coverage として数えない**。
3. **否定主張に positive と同じ証拠を要求する。** 「該当なし」「近いものが無い」
   「未使用」は、存在主張と同じだけ検証する。**指示や blueprint が「無いと書いてよい」と
   許すと、検証せずに書かれる**（実例: 3 件の「近い設計書が無い」が全て偽）。
4. **宇宙が仕様と一致するか見る。** blueprint が名指しした対象と、実際に走査された
   対象が同じか。片方だけ広い / 狭い場合、数字は正しくても結論は使えない
   （実例: 負荷測定が CPU only、blueprint は disk I/O / git lock を名指し）。
5. **記録に対象を書かせる。** 「検証した」と主張する artifact は、**何を対象にしたか**を
   自分の中に持つこと。branch / commit / path / 件数が無い gate 記録は、後から
   「どれが検証済みか」を再構成できない（transient が retention で消えた時点で復元不能）。

**A-3 の tautology 検査と対になる。** A-3 は「この test は旧 code で fail するか」を問い、
A-3b は「この census は正しい宇宙を走ったか」を問う。前者は検出器の**鋭さ**、
後者は検出器の**射程**を見る。

### A-3c. 行生存 census — 「この行はまだ在るか」を数える形（W-655）

改稿 diff の検査で最も多い census が **「旧 file の N 行のうち、新 file にまだ在るのは何行か」**
である。席は毎回これをその場で書き下ろすので、repo には残らず、同じ誤りを繰り返す。

**壊れる形（実際に踏むもの）:**

```bash
# ← これは行の内容によって嘘の答えを返す
while read -r l; do grep -Fqx "$l" new.txt || echo "LOST: $l"; done < old.txt
```

`-` で始まる行（Markdown の箇条書き、diff 断片、`--flag` を含む条文）が来ると、`grep` は
その行を**引数ではなく option として読む**。結果は「不明な option」で非 0 exit になるか、
運が悪いと別の意味の option として解釈される。どちらでも `||` 側が走り、**実際には
生存している行が LOST として数えられる**。census の値は静かに間違い、席は「N 行が消えた」と
報告する。

**正しい形 A — `-e` で終端する:**

```bash
while IFS= read -r l; do
  [ -n "$l" ] || continue
  grep -Fqx -e "$l" new.txt || printf 'LOST: %s\n' "$l"
done < old.txt
```

`-e` の後は option 解釈が止まるので、`-` 始まりでも pattern として渡る。`IFS= read -r` は
前後の空白と backslash を保つ（`read` 単体は両方壊す）。`printf '%s\n'` を使うのは、
`echo` が `-n` / `-e` を option として食う実装があるため — **`grep` で踏んだのと同じ罠**が
出力側にもある。

**正しい形 B — shell loop に依存しない（大きい入力ではこちら）:**

```bash
sort -u old.txt > /tmp/old.s && sort -u new.txt > /tmp/new.s
comm -23 /tmp/old.s /tmp/new.s        # 旧にあって新に無い行 = LOST
comm -23 /tmp/old.s /tmp/new.s | wc -l
```

`comm` は行を pattern として解釈しないので、`-` 始まりも `*` も `[` も素通りする。
1 行ずつ `grep` を起動しないため、数千行でも一定時間で終わる。**順序を見たいのでなければ
B を既定にする。**

**この census を報告する時（A-3b と対）:**

- 分母を書く。「old.txt の **M 行**を対象に走査して LOST **N 行**」。`N` だけは evidence でない。
- **`-` 始まりの行を含む入力で検証したことを明記する。** `-` を含まない入力では
  壊れた形も正しい答えを返すので、**その入力を使った試験は evidence にならない**。
  反証は両方向で取る: 壊れた形は `-` 始まりの行で誤答し、正しい形は同じ入力で正答する。
- 空行を数えるかどうかを先に決める。形 A は `[ -n "$l" ]` で落とし、形 B の `sort -u` は
  空行を 1 行として残す。**同じ入力で 2 つの形が違う数を出すのは、この差が既定でないため**。

### A-4. scope 逸脱 と pre-existing の区別

finding が (a) この diff が**新規に持ち込んだ**欠陥か、(b) diff の**外に元から在った** pre-existing か
を区別する:

- (a) 新規欠陥 → verdict の根拠にする（BLOCK / REWORK_RECOMMENDED / note）。
- (b) pre-existing → **報告（起票提案）に留め、直させない**。BLOCK 材料にしない（scope 膨張防止、
  role の item-binding hygiene と対）。`git blame` / base SHA との比較で新旧を確定してから分類。

**継ぎ目の産物 (2026-09-05)** — (a) の中で最も見落とされる class。diff が次のいずれかを**新規に**含む時は
REWORK_RECOMMENDED (根拠 = 束の切り方が依存を跨いだ signal、`planning_craft.md` §3.6「bundle の単位 = 依存の閉包」):
stub / 未実装経路の fallback / 旧 format・旧 path の受理 (互換層) / 「存在しないもの」を検出する test や scanner /
`TODO(次束)` 形の先送り comment。判定は「その code は束内の別 row が land すれば不要になるか」— なるなら産物。
directive は「消せ」ではなく「束を統合して 1 dispatch で閉じよ」を PM へ返す (row を増やさない)。
pre-existing の stub / fallback は (b) のまま。

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

### A-6. Guardian → Observer evidence pack（facts only、W-192）

code / security tier は Guardian → Observer を**同じ diff**に走らせる。両者が diff を
一から再発見するのは二度手間なので、Guardian は review 末尾に **evidence pack**
（`runtime/guardian/results/<slug>-evidence.md`、雛形 `templates/gate_evidence_pack.md`）
に**共有事実だけ**を残す — touched files / line refs / key hunks。Observer はこれを
読んで再発見を省く。

**判断は絶対に載せない**。verdict token・理由・結論・推奨を pack に書くと、独立 2 席が
相関 1 に潰れる（DEC-090、fresh-eyes 原理 = W-192d、`reuse_routing.md` § fresh-eyes）。
Observer は pack の**事実 + 自分の読み**から**自前の verdict** を出す。pack は事実の
共有であって判断の共有ではない。

強制は機械化されている（fail-closed lint）:

```bash
bun skills/garelier-core/driver/src/dispatch/evidence_pack.ts runtime/guardian/results/<slug>-evidence.md
```

leaked verdict token（PASS/BLOCK/REWORK_RECOMMENDED/NO_OPINION/PASS_WITH_NOTES）や
判断・推奨 prose（「looks safe」「should block」「問題ない」「判定」等）を author の行に
検出したら非 0 で落ちる。**diff 引用は fence（```）内、path/symbol は `inline code`** に
置けば lint 免除 — 事実は引用、prose は中立語（"touched"/"adds"/"at line N"）に保つ。

pack は任意（省略時は Observer が従来どおり自力で読む）だが、供給するなら facts-only 契約。

**lint の意図（N3）**: この非包含 lint は **accidental-leak guardrail であって collusion
barrier ではない**。うっかり verdict/判断を pack に書いてしまう事故を機械的に止めるための
もので、悪意ある Guardian が事実の選び方・並べ方で結論を暗に誘導することまでは防げない。
独立性の最終的な担保は lint ではなく **Observer 自身が自前の verdict を出すこと**（DEC-090）
にある — pack はその出発点の事実であって、Observer の判断を代替しない。

### A-7. mandatory scanner の充足条件 — probe-READY は充足でない（W-353）

`guardian_scan.ts --probe-gitleaks` が答えるのは「**実行可能か**」の 1 点だけ。
`status: "READY"` は **availability であって coverage ではない**。
**mandatory な secret / PII gate を probe だけで充足扱いにしてはならない** — 充足は
**対象 tree を実際に scan し、その結果を verdict が引用した時のみ**成立する。

| 状況 | 正しい扱い |
| :-- | :-- |
| probe READY・実 scan 未実行 | 当該 dimension は **UNCOVERED**。走っていない scan の PASS は書かない |
| probe BLOCK（実行体が無い/壊れている）+ `block_when_required_scanner_unavailable = true` | gate は **BLOCK** |
| 実 scan 実行済 | findings（または明示的な zero-finding 結果）を引用。probe の exit code を根拠にしない |

**cwd 耐性形は `cd "<worktree>" && <command>` の compound**（W-353、**operand は quote 必須**
= W-439）。unquoted の `cd <worktree> && <command>` は guard が cwd-safe 形と認めず
`tool_install_update` で deny する（実測 2026-09-03: 同一宣言で quoted=allow / unquoted=deny）。
`dispatch_prepare` の plan が印字する `quality_gate_commands_cwd_safe` は既に quote 付きなので、
**印字された byte 列をそのまま打つ**こと。harness は席の shell cwd を
**呼び出しごとに session root へ reset する**一方、declared scanner は**対象 worktree に束縛**されて
いるため、**bare 実行は reset 後に fail-closed で deny される**（これは正しい挙動 — 別 tree を
scan して緑を返すよりよい）。`cd` を前置すると segment が rebase され通る。
`dispatch_prepare` の plan はこの形を `quality_gate_commands_cwd_safe` として印字するので、
**そのまま実行する**こと。bare 形の deny を「scanner 使用不可」と読み替えないこと
（これは A-7-1 の**閉じた規則**「degraded に入るのは PM の明示 config による場合に限る」の
**一例**であって、禁止の全量ではない）。

**席が実行してよい command は、`dispatch_prepare` が席の permission record
（`quality_gate_commands`）に載せ、spawn plan に印字したものが正**。
`[guardian_tools]` の prose をそのまま打ち直すのではない — guard は canonical な
gitleaks 文法しか受理しないので、古い綴りの config はこの 2 つが食い違う。
`dispatch_prepare` はそれを `scanner_config_drift` として報告する。
**config を直すのが正で、drift 形を手打ちしてはならず、その deny を
「scanner が使えない」と読み替えてもならない**（後者は degraded mode の誤発動。これも
A-7-1 の閉じた規則の**一例**であって、禁止の全量ではない）。

digest（`sha256sum` 等）・`merge_gate_parse.ts`・`guardian_scan.ts`（`--out` なし）・
`evidence_pack.ts`・`identity_scrub_lint.ts` は preset で席から直接実行できる —
attended_record binding の有無に関わらず届く（`quality_gate_commands` が空の ad-hoc gate
spawn でも動く、W-365）。
hard-bind した raw trace の sha は**席が自分で再計算**して role 申告と突き合わせる —
申告値をそのまま verdict に載せるのは検証ではない。

**`guardian_scan.ts --out <path>` は W-379 で修理済み**: PM 制御ツリー
（`<project>/__garelier/<pmId>/runtime/{guardian,observer}/results/`）への atomic write が
どの cwd から呼んでも通る（--project から pmId を導出し、その結果置き場だけを追加で信頼する
— `--out` の値そのものから信頼を作らない）。**stdout-only 運用（`--out` 省略）はもう
回避策として必要ない** — DEC-079 の draft を正規の結果置き場に書ける。過去の stale
`*.tmp-<pid>-<uuid>` 残骸は `guardian_scan.ts --sweep-stale-drafts --project <root>
--pm-id <id>` で一括削除できる（trusted roots 配下の、この命名形に厳密一致するファイルのみ）。

#### A-7-1. scanner が席から到達不能な時の唯一の正規手順（delegated scan）

席が mandatory scanner を実行できない時、**席が独自の迂回を発明してはならず、実行できないまま
PASS を書いてもならない**。正規経路は 1 本だけ:

1. 席は **escalate** する（「実行できない」旨と、試した command verbatim + **deny 理由を名指し**）。
2. **Dock が対象 range / target を明示して delegated scan を実行**する（席の推測に委ねない）。
3. 結果を **evidence file に verbatim 記録**する — 実行した command、対象 range/target、
   **その scan が対象とした `base` / `head` の SHA**、出力（findings、または明示的な
   zero-finding 結果）をそのまま。要約で置換しない。
4. **席はその evidence file を citation として verdict に使う**。verdict には
   **scan の実行者が審査席ではなく Dock であること**を明記する。

##### SHA 束縛（必須）

**step 3 の SHA は任意項目ではない。** branch 名は可変なので、「range/target を書いた」だけでは
**scan された tree と審査している tree が別でも字義を満たしてしまう**。基準は
**それが縛る対象の外側から**取らねばならない — 対象自身から導出した基準は、その対象が
正しいかを答えられない（本 row が code 側 AC(b) で塞いだのと同一の誤り）。

- evidence file は `Reviewed SHA` / `Base` を持つこと（header 規約は
  `templates/gate_evidence_pack.md` に倣う。**artifact 自体は流用しない** — あれは
  Guardian→Observer の facts-only 用で verdict token に対して fail-closed に lint される）。
- **引用する席は、記録された base/head が自分の `review_sha` に解決しない evidence file を
  拒否しなければならない（MUST refuse）。拒否の verdict は `BLOCK` である。**
  「記録せよ」だけで拒否義務を書かなければ、**束縛されて見えて誰も検査義務を負っていない
  artifact** ができる。
- これは A-7 の「hard-bind した sha は席が自分で再計算する」と**同じ規律**。申告された
  scan 結果を、束縛も再計算もせず verdict に載せてはならない。

##### citation が間に合わない時 — `UNCOVERED`

代行 scan の結果が**席の turn 内に届かない**ことがある。その dimension の status が **`UNCOVERED`**:

**`UNCOVERED` は dimension status であって verdict token ではない。** `[verdict] result` に
書けるのは `OBSERVER_VERDICTS` / `GUARDIAN_VERDICTS` の member
（`PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` / `NO_OPINION`、
`merge_gate_parse.ts`）**のみ**。uncovered dimension は **`[[uncovered]]` table で申告**する。
`[verdict] result = 'UNCOVERED'` と書くと parser は null を返す（fail-closed で安全側ではあるが
malformed marker になる）。

- **citation が存在するまで `PASS` は書けない**（`PASS_WITH_NOTES` も不可 — note は非 blocking で、
  未実施の scan は非 blocking ではない）。**ただしこの bullet は delegated path に限る** —
  趣旨は**他者の scan に依拠する時に、存在しない evidence file を引用して PASS しない**こと。
- `UNCOVERED` は「この dimension は未充足のまま」を意味し、PM が代行 scan を完了させて
  citation を供給するまで解消しない。
- **seat binding が成立しない席（cross-repo 等）も `UNCOVERED`** であり、これが本来の姿。
  ただしこの場合**何も delegate されていない**（席は自分の coverage を正直に述べている）ので、
  上記 1 番目の bullet は適用されない。
  **W-365 で cross-repo binding 自体に経路が付いた** — PM が
  `attended_record --additional-root <target-repo>` で対象 repo を明示宣言すると、
  `gitleaksSeatIsBound` / `declaredSeatCwdIsBound` は席の worktree だけでなく declared
  additional root への `cd` も bound と認める（未宣言の repo は従来どおり deny のまま —
  opt-in のみで ambient には広がらない）。**declared additional root がある席は
  `UNCOVERED` を書かず実 scan を引用してよい**。additional root が declare されていない
  cross-repo 席は、従来どおり上記 delegated scan 経路か `UNCOVERED` 開示のどちらか。

###### `UNCOVERED` は dimension に付く label であり、verdict の禁止ではない

上の 3 bullet を通して読むと「binding できない席（W-365 が land するまでの全 cross-repo 席）は
一切の passing verdict を出せない」と読めてしまう。**その読みは誤りで、採用すると
W-365 自身を含めて何も land できなくなる**。

- `UNCOVERED` は **dimension** に付く label であって、**verdict の禁止ではない**。D3 が
  これを導入した目的は**席が答えを発明しないこと**であって、席を沈黙させることではない。
- `UNCOVERED` dimension を持つ **passing verdict は次の 3 つを必ず書く**:
  **(a)** どの dimension が uncovered か **(b)** 原因と追跡 row **(c)** **その verdict の確信が
  代わりに何に依拠しているか**（例: registry scan の全量、依存変更ゼロの N file 差分の全読）。
- **正準 grammar（W-370、front matter 化 W-638）**: dimension ごとに front matter へ
  `[[uncovered]]` table を 1 つ書く。4 field すべてが必要で値は空にできず、`tracking_row` は
  `W-N` 形式である。secret/PII hard stop の dimension key は `secret_pii`。

  ```toml
  [[uncovered]]
  dimension = 'secret_pii'
  cause = '''<nonempty>'''
  tracking_row = 'W-N'
  alternate_confidence_basis = '''<nonempty>'''
  ```

  **table を 1 つも書かなければ「uncovered dimension は無い」**である。旧 grammar は散文中の
  field らしき行を探して「finding が在るか」を判定していたため、coverage について否定文を
  1 行書いただけの Guardian が「不完全な UNCOVERED 開示」で拒否され、`UNCOVERED` という語を
  避けて書き直させる回避が別の 2 束へ伝播した（W-619 UC-1）。**その回避はもう要らない** —
  `UNCOVERED` という語を散文のどこに書いても判定は変わらない。**ただし退役形そのものは別**:
  `uncovered_dimension:` / `uncovered_cause:` / `uncovered_tracking_row:` /
  `alternate_confidence_basis:` で始まる行が散文に在ると、`[[uncovered]]` table の有無に
  関わらず verdict は明示 reject される（DEC-046）。table と散文の混在だけが
  「parser には完全な開示、書き手には申告済み」に見え、secret/PII の hard stop を静かに
  落とすため、読むのでも無視するのでもなく拒否する。
- **拒否義務（開示だけで終わらせない）**: **(a)(b)(c) のいずれかを欠く passing verdict は、
  それを取り込む側（merge gate / その verdict を引用する席）が拒否しなければならず、
  拒否は `BLOCK` である。** 記録義務だけ書いて拒否義務を書かなければ、**束縛されて見えて
  誰も検査義務を負っていない artifact** ができる（D1 で確定したのと同型）。
  **機構化は W-370**（条文が義務を定め、`merge-gate.ts` が Guardian report を policy backstop へ渡す実装はそちらで持つ）。
- **hard stop（席の自己評価ではなく diff から導出する）**: **diff が security-sensitive /
  package-file の trigger を踏み、かつ secret / PII dimension が `UNCOVERED` である場合、
  席は passing verdict を出してはならない。** trigger の判定は
  `guardian_policy_check.ts` の `policyReason()` に従う — すなわち**変更 file 一覧から機械的に
  決まり、席の判断ではない**（`[guardian_policy.package_files]` の basename 一致 →
  `require_for_dependency_changes` / `[guardian_policy.security_sensitive_paths]` の glob 一致 →
  `require_for_auth_security`）。
  **要点は「席以外の誰かが検算できる」こと**。「主 risk か」を PASS したい当の席に自己評価させる形は
  原理的に検算できず、**縛る対象の内側から基準を取る**ことになる（本 row が正す誤り class そのもの）。
  **この hard stop があるから上の許容が抜け穴にならない**。

  **worked example（本 row 自身に規則を当てた結果）**: 変更 file は **11 件、すべて `skills/**` 配下の
  `.ts` / `.md`**。`[guardian_policy.package_files]` の basename（`package.json` / `Cargo.toml` 等）に
  **一致なし**、`[guardian_policy.security_sensitive_paths]` の glob（`.env*` / `**/*.pem` / `**/*.key` /
  `**/*secret*` / `**/*credential*` / `infra/**` / `deploy/**` / `.github/workflows/**` / `migrations/**`）にも
  **一致なし** → **hard stop は発火しない**。既に出ている Guardian の PASS と整合する。
  これは**後付けの正当化ではなく、規則を機械的に当てた結果が独立に出た判定と一致する**という確認であり、
  同時に「trigger は席の判断でなく変更 file 一覧から決まる」ことの実例でもある。

裁定の理由: **環境的な gap を全 gate の停止に変換する規則は degradation-by-omission** —
gate が無い状態は、1 dimension を正直に uncovered と書く gate より**厳密に悪い**。
かつ**自分の前提条件を直す変更を land できなくする規則は自己破壊的**である
（W-365 が land しなければ席は永久に UNCOVERED、しかし UNCOVERED では何も land できない）。

同じ理由で、**gate を律する規則は gate 対象の artifact の外から来なければならない**。
候補段階の doctrine を自分自身の merge の判定に使えば、**基準を対象の内側から取る**ことになり、
本 row が正すために存在する誤りそのものになる。

##### degraded mode に入れる条件（閉じた規則）

**degraded mode に入るのは、PM の明示 config — `[guardian_tools].secret_scan` が
`DISABLED_VALUES` のいずれかであり、かつ
`[guardian_policy].block_when_required_scanner_unavailable = false` — による場合に限る。
いかなる形の guard denial も degraded の根拠にならない。**
（**値の集合は code 側の `DISABLED_VALUES`（`guard/gate_seat_commands.ts`）が正本。
条文で値を再掲しない** — 再掲した瞬間に、それ自体が「列挙で class を閉じたつもりになる」形になり、
条文と code が黙って乖離する。）

この規則は**肯定形で閉じている**こと自体が要点。禁止事例の列挙（drift 形の deny を degraded に
読み替えない 等）は**この規則の例示**であって禁止の全量ではない。列挙で塞ぐと、著者が
思いつかなかった deny（例: seat binding の deny）が**どの成文も破らずに**degraded の口実になる。

delegated scan は degraded mode と**別物**: coverage を落とさず実行者だけを移す。
`secret_scan = "off"` は coverage 自体が下がる。**一方を他方と呼んではならない**（verdict が
どちらだったか必ず判るように）。

##### 是正義務 — delegated を恒常経路にしない

**delegated scan を発動したら、到達不能そのものを是正する row を起票する義務がある。**
deny を踏んだら step 1 で**理由を名指し**し、

- 理由が **config drift** なら是正は **config 側**であり、delegated はその **1 回限りの橋渡し**。
- 理由が機構欠陥なら **reachability 是正 row** を起票する。

本手順の trigger は **PM の 4 連続代行**だった。**是正義務なしに代行を条文化すれば回避策が恒久化し**、
「手作業 2 回 = 機構欠陥 signal」の原則に正面から反する。delegated の反復は成功ではなく欠陥の計測値。

禁止: 席が evidence 無しで PASS を書く / probe の READY を scan 結果の代わりに引用する /
citation 無しに「PM が確認済み」と書く / SHA 不一致の evidence を引用する（= BLOCK すべき所を通す）。

→ `../../garelier-guardian/references/scanner-and-gates.md`、
`../../garelier-librarian/templates/security/scanner_runbook.md`

### A-8. 自分の席が在るのは register に REQUIRED GATE block が在ったから（W-641）

Guardian / Observer seat は `review_prepare.ts` の Dock review handoff が
`Gate result: GREEN (exit 0)` になって初めて発行される。その gate は
`gate_runner.ts --from-register <producer register>` として走るので、**席が存在すること自体が
「producer register に `=== REQUIRED GATE (Dock-run) ===` block が在り、その step が実走して
GREEN だった」ことの帰結**である。block の書式・必須性・PM 選定 step の規約は provider 非依存で
[`worker_field_manual.md` §5b](worker_field_manual.md) が正本 — codex lane と claude lane
(attended-agent / claude-subprocess) で書き方は変わらない。

- 席の prompt / task file に「gate を自分で走らせろ」と書かれていたら **それは誤り**。gate は
  Dock 席が既に実走している。席がやるのは `final_accounting.md` / gate log の**引用**であって再実行ではない。
- `final_accounting.md` の `- Gate result:` と gate log の terminal `RESULT` が食い違う register は
  BLOCK 対象 (accounting は gate log の最終 executed run から導出される)。ただし**判定の正本は
  seal** — 両者とも producer-writable な lane 配下の file で、seal は両方の digest を持つ
  (W-710)。席の側で log を parse し直して GREEN を再判定しない (§A-8b)。

### A-8b. seal がどの run を束縛するかは driver が全部決める（W-693 / W-711）

**producer の report は gate run を書かない。** `review_prepare` は自分が書いた Dock review
record と、その record が持つ gate log の digest だけで「再利用するか実行するか」を決める。
register の `[gate] gate_run_id` 要求は **W-711 で撤回**した（field 自体が
`templates/report.md` から消えている）ので、**「report が引用する run が seal と違う」は
finding として成立しない** — 直した report を seal すると当時は新しい run が生まれ、また
不一致になった（#394 r43/r44）。

**`decideGateRun` の分岐 全数（この表が正本、他面はここを指す）:**

| # | 条件（上から順に評価） | 結果 | `- Gate run source:` に出る理由 |
| ---: | :--- | :--- | :--- |
| 1 | `--rerun-gate` が渡された | 実行 | `--rerun-gate requested` |
| 2 | log に terminal run が無い（初回） | 実行 | `no terminal gate run in the review log` |
| 3 | 最終 run が RED | 実行 | `last gate run <id> is RED` |
| 4 | 最終 GREEN run に `run_id` が無い | 実行 | `last GREEN gate run carries no run_id to bind` |
| 5 | この log bytes に対する Dock review record が無い（digest 不一致・identity 不一致・producer が append した forge を含む） | 実行 | `no Dock review record binds GREEN run <id> over these log bytes` |
| 6 | record が別の run を束縛している | 実行 | `Dock review record binds run <A>, the log's last GREEN run is <B>` |
| 7 | register の宣言 REQUIRED GATE step が seal 時から変わった | 実行 | `the register's declared REQUIRED GATE steps changed since the sealed run` |
| 8 | 上のどれでもない | **再利用** | `reused (Dock-sealed run <id>)` |

**refuse は無い**（8 分岐すべてが実行か再利用に落ちる）。席が「Dock が producer に run id を
書かせるために止まった」形を見たら、それは**この版より前の手順書**である。

席が見るのは:

- `final_accounting.md` の `- Gate run source:` = `executed (<上表の理由>)` か
  `reused (Dock-sealed run …)`。
- seal (`runtime/dock/review_handoff/dispatch<N>.json`) の `gate_run_id`。**log を読み直して
  照合する必要はない** — seal は log の digest を持っており、後から書き換われば検出される。

**P-9 (gate が測った tree) の判定形 — seal を読む、log を読まない（W-710）:**

- `gate_runner` は step 実行直前と全 step 終了後に `git rev-parse HEAD` と `cwd` を取り、
  **run record** (`<pm runtime>/gate/run_records/<log basename>.<log path digest>.json`) へ
  typed field として書く。**log の隣には置かない** — log path は caller が決める値で
  gate が測る tree の中を指せるため、隣に置くと untracked sibling が次 run の step identity を
  落とす (#464 r1 の実測)。seal はその値を
  `gate_start_head` / `gate_end_head` として複写し、run record 自身も digest 済 evidence に含める。
- **判定 = `gate_start_head == gate_end_head == review_sha`**。この 3 つが揃わない run は
  `review_prepare` が **seal を書く前に refuse** するので、席に届いた seal は既にこれを満たす。
  席が log の `GATE_START` / `RESULT` を数え直す必要は無い（同じ問いに弱い答えを 2 つ作らない）。
- 1 つの log に 2 run が append されていても、**束縛される run は 1 本**（run record は最後の run が
  置き換えるので「この log が終わった run」の答えが 1 つしかない）。log の最後の `GATE_START` を
  読んで seal と突き合わせる旧手はもう使わない — 追記された偽 run を指してしまう。
- 両 head が `""` の seal は「run が自分の tree について何も言わなかった」を意味する
  (`gate_runner` を通っていない run)。**その seal は再利用されない**ので、次の Dock 呼出しは
  必ず gate を実行する。

`- Gate run source:` が `executed` なのに理由が上表のどれとも読めない時だけ、**Dock 手順の逸脱**
（`--rerun-gate` を付けて回した／seal を手で書いた）として名指しして返す。

### A-8c. 候補が driver 自身を変えている時、gate は候補側 script が回す（W-691）

候補の diff に `skills/garelier-core/driver/src/` が含まれる dispatch では、
gate の契約（log marker / seal の artifact 集合 / step 分類）を**候補が定義している**。
studio に install 済の script で回すと候補の契約は成立せず、席は「候補の契約で consume 可能な
formal GREEN が無い」と読む。#394 はこの形で r34〜r40 の 7 round を消費した。

- **席の確認点** = `final_accounting.md` の `- Gate script source:` 行。
  `candidate` なら候補側 script が回した。`studio` なのに候補 diff に driver path が在る、
  または `studio (candidate driver changed but … is absent)` なら、**候補の gate 契約は
  検証されていない** — 席はそれを finding として名指しし、PM へ返す（席が回し直さない）。
- **席が gate を回すことは無い**（§A-8）。この節も同じで、回すのは Dock、席は出所を読むだけ。
- **`candidate` は「合格」ではなく「seal を書いた code が候補のもの」を意味する**（W-693 F-5）。
  委譲した round では、fence 外の Dock review record を含む seal 一式が**候補 checkout の
  producer-authored code** によって書かれる。席は `candidate` を見たら `review_prepare.ts` /
  `gate_runner.ts` の diff を**読んでから** seal を信用する — 委譲は「候補の契約で回した」
  ことの記録であって、その契約が正しいことの保証ではない。

---

### A-9. 席の任務に「前提の検証」を含める（W-364）

gate 席は差分を審査する前に、**その審査が乗っている前提を 1 度だけ導出する**。
下の 2 項は §A-0〜§A-8 と同格の**任務項目**であり、余力があればやる調査ではない。
`§C` の pattern 選定で何を頼まれていても実行してよく、**§2 の「Scout 的自由調査へ広げない」
とは衝突しない** — 対象は目の前の row / blueprint / diff の前提そのものであって、
その外側の探索ではないからである。

**(1) 前提の実 code 導出。** 「この row / blueprint の前提は、実 code 上どの経路で成立するか」
を 1 度導出する。row が「X が Y を呼ぶので Z が保証される」と書いているなら、その呼出が
実在する経路かを file + symbol で確かめる。**前提が成立していなければ、diff がどれだけ
正しくても成果は無い。** 実例の形: 「gate が verdict を control へ書く」という前提は、
書き込み関数の caller 集合を数えて初めて確かめられる。導出結果は 1 行で verdict に書く
（「前提 P は `<file>::<symbol>` 経由で成立 / 成立しない」）。

**(2) 基準値の出所。** 判定に使う基準値について、**どこから来た値か**と
**検査される側がその値に影響できるか**を確かめる。

| 出所 | 影響可能か | 席の扱い |
| :-- | :-- | :-- |
| 判定対象の外にある正本（仕様書・engine 定数の default・上流 schema） | 不可 | そのまま使う |
| 検査される側が同じ diff で書いた宣言（register の自己申告値・candidate 内の期待値 file） | **可能** | 基準値として使わない。外から導出し直す |
| 前 round の値をそのまま持ち越したもの | 場合による | 現 SHA で取り直す。持ち越しは基準値でなく履歴 |

**自己参照検査**がこの罠の典型である: 検査する側と検査される側が同じ file の同じ宣言を
読むと、宣言を書き換えるだけで両方が同時に動き、検査は常に通る。**「同じ文字列が 2 箇所に
在る」形は、共有していることの証明にならない** — 一方を変えたときに他方の判定が変わることを
示して初めて共有が証明される。

**(3) 「開示だけで終わらせない」義務**は既に §A-7 帯に在る（(a)(b)(c) を欠く passing
verdict の受理は BLOCK）。**ここには複製しない** — 同じ規則を 2 箇所に書くと、次に条文を
足す席が両方を読むことになる。(1)(2) で前提の欠落を見つけた場合の処理はその条文に従う。

#### A-9 が要求する反証の作法

- **counterfactual を 2 本**取る。(a) 新しい guard を**欠陥が在った時点の data** に当てて
  発火すること、(b) 旧 guard が**同じ data** で 0 件であること。(a) だけでは「新 guard が
  何かに反応した」ことしか言えず、(b) だけでは「旧 guard が鈍い」ことしか言えない。
- **counterfactual は blind spot の外側へ注入する。** guard が見ている場所に欠陥を置いても、
  それは guard の設計どおりに見つかるだけで、射程を測っていない。
- **抜け道は列挙ではなく肯定形で閉じる。** 「A も B も C も禁止」は D で破られる。
  「許されるのは P を満たす形だけ」と書けば、D は自動的に外れる。禁止の列挙を見たら、
  その裏にある肯定形を席が要求する。

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

## §C0. gate tier 選定表 — 何席立てるか（機械化: dispatch_prepare `gate_plan`, W-192）

§C は「gate を書く時にどの観点を頼むか」。§C0 はさらに上流 — **そもそも何席の
gate を立てるか**の risk-tier 決定表。DEC-093 の運用（軽い docs 変更を security
code と同じ gate に通さない）を機械化したもので、`dispatch_prepare` が dispatch の
宣言 touches / tags から tier を分類し `gate_plan`（`{tier, seats, pm_review_only,
gate_model_floor, rationale}`）を emit する。PM は `gate_plan.seats` の席を**そのまま**
立てる（席数を手で推測しない）。分類は fail-safe に倒す — 不明・空 scope は `code`
（=全 gate）で、docs-only に誤分類して gate を落とすことはない。

| tier | 判定（touches/tags） | 立てる席 | model | なぜ |
| :-- | :-- | :-- | :-- | :-- |
| **docs-only** | touches が全て doc（`*.md`/`docs/`/`references/`/`*.txt`…） | **なし（PM diff review のみ）** | — | code/security 面が無く gate 役が見るものが無い。ただし**他者が実行する rule/spec を含む doc は `code`**（docs-only ではない） |
| **test-only** | touches が全て test（`*.test.*`/`tests/`/`__tests__/`…） | **Observer 1 席** | 既定 | 主 risk は test の恒真性・判別力（§C-2）= Observer 領分。**fixture に実データ/secret が載る場合は security（or `--full-gate`）へ escalate して Guardian を足す** |
| **code** | source を 1 つでも含む / 不明・空 scope | **Guardian + Observer** | 既定 | 通常の 2 席 gate: Guardian（security/license/provenance）→ Observer（correctness/quality）、独立性維持（DEC-090） |
| **security** | `security` tag、または guard/auth/crypto/secret/security path への touch | **Guardian + Observer** | **opus floor** | Guardian 主担（bypass 敵対探索）、Observer は品質面で補完し security 軸を二重化しない（§C-8）。gate model を opus 未満から opus へ floor |

**tier plan は提案、project policy floor が勝つ**: `[guardian_policy]`/`[observer_policy]`
の `enabled + require_for_all_merges`（= 全 merge に該当 gate 必須、asset/docs 含む）が
有効な project では、tier がそれを下回る席数を出しても **floor が席を足す** —
`dispatch_prepare` は merge gate の **`require_for_all_merges` branch について同一条件**
（`enabled && require_for_all_merges`）を読み、docs-only でも Guardian/Observer を
`gate_plan.seats` に載せ `policy_floor_applied` に記録する（silent 0 席にならない）。
merge gate（`guardian_policy_check` / `observer_policy_check`）が最終 backstop なので、
仮に plan が floor を漏らしても merge は refuse される — plan は「前もって正しい席を出す」
層。floor は席を**足す**だけで tier の gate を下げることはない。

backstop 自体が config を読めない、git diff を計算できない、または internal failure に
なった場合も「gate 不要」ではない。両 policy-check は stdout に machine-readable な
`{status:"BLOCKED", required:true, ...}` を返し、merge authorization を停止する。空 stdout
は policy disabled / passing verdict 済み / trigger 非該当を正常に評価できた場合だけ。
merge-gate caller も policy-checker、PM namespace、config path を発見できない場合は同じ
machine-readable BLOCKED 形を生成し、backstop を silent skip しない。

**honest residue（N1）**: `gate_plan` は **PREPARE 時の申告 touches による分類 = 提案**で
あって security boundary ではない。過少申告した dispatch（実際は code を触るのに docs-only
と申告）に対する防御は、gate_plan ではなく **merge gate 側** — policy floor（上記）+
`record_touches` による申告 vs 実 diff の drift 検出 — が担う。gate_plan は「正直な申告に
対して正しい席数を前置きする」最適化であり、敵対的な過少申告を止める層ではない。

**同一条件の scope（N2）**: 上の「merge gate と同一条件」は `require_for_all_merges` の
枝**のみ**を指す。merge gate の他の refuse 面（`require_for_protected_paths` /
dependency / lockfile / auth_security 等）は **merge gate 側だけ**が評価するので、
`gate_plan` はそれらについて **under-propose し得る**（例: protected path を触る docs-only は
gate_plan が 0 席のまま）。ただし merge gate が fail-closed backstop として最終的に refuse
するので安全側に閉じる — gate_plan の目的は proposal の最適化であって強制ではない。

**tier は §C の pattern と直交**: §C0 が席数を決め、§C がその席に頼む観点を決める。
例: security tier（§C0）→ Guardian に §C-8 の焦点分離、Observer に品質面を発注。

---

## §C. PM の review pattern 選定表（発注側 — どの状況でどの観点を頼み、なぜか）

§B は Observer 自身の思考技法。§C はその上流 — **PM が blueprint の Gate 重点を
書く時に「どの review pattern が必要か」を状況から引く表**。pattern 本文を gate
prompt に複製してはならない（A-0）。実戦由来 (target project 2026-07 の B2 campaign
8 gate + REWORK 回収 trail から一般化)。

選定は排他でなく**合成**: pattern 1 (AC 照合) を必ず基本に置き、状況に該当する
pattern を 2〜3 個まで重ねる (4 個以上は焦点が散って全部浅くなる)。

| # | 状況 (trigger) | 発注 pattern | blueprint に書くこと | なぜこの pattern か |
| :-- | :-- | :-- | :-- | :-- |
| 1 | 全 gate 共通の基本 | **AC 番号照合** | AC を番号列挙し、各々 satisfied / deferred / missing + file:line 証跡を要求。「blueprint 明記の defer は OK、明記なき欠落は所見」と対称性を伝える | 番号がないと re-gate で所見↔AC の対応が迷子になる。defer 対称性が role/gate の解釈揺れを消す |
| 2 | AC が test で pin される変更、test 数が少ない (新 crate 3-6 本等)、検証系 (census/audit/coverage) | **非恒真 (anti-tautology) 逆証明** | 「逆変更 (誤 kind / 破壊 / 逆順) で RED になるか」を要求。恒真形の具体例 (同値 2 回生成の等値 assert、母集合=検証対象の自己参照) を blueprint に挙げる | 恒真 test は gate を素通りする false 安心を作る — 恒真 census が HOLD まで届いた実事故が起源。§B-3 を発注側から強制する形 |
| 3 | REWORK / HOLD 後の再提出 | **re-gate 限定** | 前回所見を番号列挙し「各々が直っているか」**のみ**を問う。新規観点の追加を明示的に禁じる | 観点を変えて review し直させると別の note が湧いて収束しない — roundtrip が 1 回で閉まらなくなる |
| 4 | crate 移設 / rename / 分解構築 | **移設同型性** | rename similarity (git の %)、moved 部分の byte 温存、public path (`pub use` alias) 温存、下流利用の green 維持を要求 | 「移設のついで」の挙動変更が最も混入しやすい経路。similarity 98% の残り 2% を読ませる |
| 5 | 数値表現の置換 (float→integer、fixed-point 化、RNG 変更、hash 変更) | **分布 / 等価保存** | 置換前後の数学的同値の逆証明 — 閾値導出 (floor(p·2^N) 型)、丸め方向、境界 (0 / 1 / MAX)、overflow 中間型を点検させる | test green でも分布・境界が微妙に変わりうる。決定論 campaign では「ほぼ同じ」は回帰 — 保存則を式で確認させる |
| 6 | campaign の直列 workstream (他 stream への縫い目を stub で残す変更) | **seam 整合** | role の stub seam 宣言 vs blueprint の workstream 分割表を照合。「本 AC を stub で誤魔化していないか」を問う | 直列分割では defer の正当性判定が gate の本丸 — seam が blueprint に無い独自判断なら scope 漏れの signal |
| 7 | infra / primitive / 機構の新設 | **production wire** | 新機構の caller chain を git grep で追跡させ、「production 経路に実配線されているか、consumer 0 の helper になっていないか」を問う | helper/test inflation antipattern (production consumer 0 の積み上げ) を gate で止める。「後で使う」は wire でない |
| 8b | row / blueprint が「X なので Y が保証される」型の前提に乗っている、または合否が数値・閾値・期待値の一致で決まる | **前提と基準値の検証 (§A-9)** | 前提が実 code のどの経路で成立するかを file + symbol で 1 行示すこと、判定に使う基準値の出所と「検査される側がその値に影響できるか」を示すことを要求する。席は §A-9 を任務として実行してよく、これは §2 の scope 逸脱にあたらない | 前提が偽なら diff の正しさは成果にならない。基準値を検査される側が書いていると、検査は宣言を書き換えるだけで常に通る (自己参照検査)。どちらも diff だけを読んでいる限り見えない |
| 8 | security row (traversal / fail-open / sealed / 暗号) | **焦点分離 (Guardian 主担)** | bypass 敵対探索・防御配置は **Guardian** に置き、Observer には AC 品質・error 文言の作者可読性・fixture の判別力・lane 対称性を発注 | 同じ観点を両 gate に書くと片方が形骸化する。security の本丸は Guardian、Observer は品質面で二重化しない補完 |

**全 pattern 共通の配置規則**:

- review pattern / AC / Gate 重点は blueprint に 1 回だけ書く。gate prompt は blueprint path と
  「これが正本」の 1 行だけで参照する。
- Dock gate の結果は dispatch 固有なので、gate prompt に log path + `GREEN` / `RED` だけを
  置いてよい。結果の解説や role 主張を複製しない。
- 検証水準 (§A-2)、blocking / non-blocking (§A-5)、verdict marker 契約 (§A-1) はこの manual / role
  SKILL / template が正本である。prompt に再掲しない。
- prompt にも伝えたい新しい判定基準を見つけたら、dispatch 前は blueprint を直す。走行中は
  bound blueprint を変えず、land 後の統合対象として記録する。

**Wanderer/design-review (DEC-076) は本表の外**: dispatch 前の設計 review は
`design_campaign_playbook.md` (census 接地 / citation spot-check / R-list) が正本 —
本表は「実装済み diff への gate」の選定表。

---

## §C1. rework 再検査 — 同席 delta re-gate 既定（W-192c）

BLOCK / REWORK_RECOMMENDED → rework 後の**再検査は、初回と同じ G/O 席へ delta で
依頼するのが既定**。初回 context を保持しているので安価で、§C-3（re-gate 限定）と整合
する。W-191(d)「gate は常に fresh」と矛盾しない — あれは**dispatch 跨ぎ再利用の禁止**、
これは**同一 engagement 内の継続**（別層、両立）。同席が保持しているのは「何を指摘したか」
= 検査 spec であって、判定対象への stake ではない（§D の warm 可条件）。

**必須 2 項**（どちらか欠けると roundtrip が閉じない）:
1. **指摘 close の確認** — 前回所見を番号列挙し、各々が直っているかのみを問う（§C-3）。
2. **fix diff が新たに開けた問題の scan** — anchoring 対策。修正が別の穴を開けていないか
   を、指摘 close とは別に必ず見る（実例: sed fix の後に追い fix が必要になった class）。

前回所見の本文を re-gate prompt に複製しない。同席は自分の canonical report を読み、fresh 席は
前回の verdict marker / canonical report を正準 path から読む。prompt は A-0 の閉じた情報だけを運ぶ。

**fresh へ切替える条件**（同席 delta をやめて新席を立てる）:
- rework が**的絞り修正を超えて scope 拡大**した（もはや delta でなく別 diff）。
- **席が消失**した（session 跨ぎ等）— その場合は前回の verdict marker を入力に fresh 席。

---

## §D. gate independence — warm vs fresh の原理と配当（W-192 d/e/f）

§C0〜§C1 の「いつ fresh / いつ warm」の**導出根拠**。表の数字でなく原理で持つ。

### D-1. fresh-eyes 原理 — fresh 必須 = 既存 context が判定対象への stake を含む時

**fresh を要求するのは context の「大きさ」でなく「利害」**。既存 context が判定対象への
**stake（自分の結論・意図・完了主張）**を含むなら、その席の判断は相関して独立性が消える。
5 類型:

| # | 場面 | なぜ fresh 必須 |
| :-- | :-- | :-- |
| 1 | 実装者 → 検証者 | 自分の**意図**を検証してしまう（実装の前提を疑えない） |
| 2 | Guardian → Observer に**判断**共有 | 独立 2 サンプルが相関 1 に潰れる（**事実共有は可** = §A-6 evidence pack） |
| 3 | refuter 票 | 票の独立性（他票を見た refuter は独立票でない） |
| 4 | 完了主張の買い直し | 「done」と言った本人の再確認は確認バイアス |
| 5 | audit-loop | 修理本人は finding 0 を宣言できない |

**warm 可 = 既存 context が facts のみ**の時: 同席 rework 再検査（指摘 = 検査 spec、§C1）/
隣接 task 直列 / PM 継続。**長 context の劣化は独立性でなく容量問題** = fresh「推奨」
(rotation) 止まりで、fresh「必須」ではない。

### D-2. compact-fresh 運用既定

独立性が要求するのは**新しい context であって大きな context ではない**。fresh のコスト
削減は **入力圧縮（§A-6 evidence pack）+ 席数 tier（§C0）+ model tier** で行い、**stake
境界の内側を warm 化して削ることはしない**。low-stakes（docs-only 等）の warm 容認は
§C0 の tier が既に encode 済み。

### D-3. 5 軸配当 — warm/fresh 選択の根拠

推奨既定 = **role warm / verifier fresh** は次の配当から導かれる:

| 軸 | warm 側 | fresh 側 |
| :-- | :-- | :-- |
| ① 捕捉欠陥種 | 連続性欠陥（隣接 slice の縫い目） | 作者盲点系（前提の穴）— 網を張る欠陥 class の選択 |
| ② 誤り相関 | 直列 = 系統複製のリスク | rotation がその保険 |
| ③ 一貫性 vs 多様性 | role は一貫性（warm） | verifier は多様性（fresh）— role 境界の実質根拠 |
| ④ token・レイテンシ | delta で安い | evidence pack で単価圧縮（§A-6） |
| ⑤ 監査可能性 | — | fresh のみ「独立導出」を trail 主張可（gate / Engine Complete 判定の証明力） |

→ warm/fresh の reuse 側運用は `reuse_routing.md`（§ fresh-eyes rule）。同原理の 2 面。

---

## §E. build cache が gate 時間を決める（消費側 project が Rust の場合）

heavy gate の所要は **test 実行時間ではなく compile 時間が支配する**。
実測 (2026-08-23、消費側 project の 19 step gate 合計 30.4 分):

| step | 内容 | 所要 |
| :--- | :--- | ---: |
| 自前 crate の test build | `cargo test -p <crate> --lib` | **8.2 分** |
| 実行 binary の build | `cargo run -p <bin> -- --headless` | **7.3 分** |
| 残り 17 step | | 計 ~15 分 |

**gate は毎回 fresh worktree (`_crew/dispatch<N>/checkout`) で走る**ため
`target/` が空から始まる。したがって **build cache の共有が gate 時間を直接決める**。

### E-1. 起動側が cache を殺していないかを見る

`spawn_env.ts` は role 席で **`RUSTC_WRAPPER` / `RUSTC_WORKSPACE_WRAPPER` を
空へ潰す**。これは
「**sandbox role が machine-wide な cache server の最初の起動者になるのを防ぐ**」
という正当な設計だが、**消費側 project が project config
(`.cargo/config.toml` の `rustc-wrapper`) で wrapper を指定していれば
そちらが honor される**。

**判定**: 消費側が cache wrapper を使う設計なら、
**project config 側に置かれているか**を確認する。
home config (`~/.cargo/config.toml`) だけに置くと
**隔離 worktree が読まず cold full compile になる**。

### E-2. cache key に絶対 path が入る — worktree 分だけ cache が分裂する

sccache は **source の絶対 path を cache key に含める**。
dispatch worktree は `_crew/dispatch<N>/checkout/` と **番号ごとに別 path** なので、
**既定では同じ内容でも worktree ごとに別 cache を積む**。

- 消費側の `[env]` に **`SCCACHE_BASEDIRS`** を置いて base を strip する
- ただし **worktree root は番号が動的**なので、
  **静的指定は studio build にしか効かない**。
  **gate / worker の起動側が checkout root を `SCCACHE_BASEDIRS` へ追加する**のが本体
- 実測の確認法 = `sccache --show-stats` の **`Base directories`**

### E-3. incremental は cache されない

sccache 公式 (`docs/Rust.md`) は
「**rustc's incremental compilation needs to be disabled**」と明記する。
**incremental が有効な crate は cache されない**。

cache は全 worktree 共有なので、**開発ループが incremental のままだと cache が積まれず、
`CARGO_INCREMENTAL=0` で走る gate も hit する母体を持たない**。
消費側 project の `[env]` に `CARGO_INCREMENTAL = "0"` を置く。

### E-4. `--show-stats` の読み方（誤読しやすい 3 点）

- **`Non-cacheable calls` は cache miss ではない** — 「そもそも cache 対象外」の呼び出し。
  実測内訳 = **`multiple input files` が 85%**（build script / proc-macro など
  複数入力を持つ呼び出しで、**原理的に cache できない**）。
  **hits rate の分母には入らない**ので
  「hits rate が低い = 設定が悪い」と短絡しない
- **client-side mode では `Compile requests` が 0 のことがある** —
  stats は server 所有のまま、compile は client 側で走るため。
  `Compile requests executed` 側が実数。**server 再起動の兆候と誤読しない**
- **preprocessor cache mode は C/C++ 専用** — Rust には効かない

### E-5. config を触ったら parse を確認してから gate を回す

**実害 (2026-08-23)**: PM が消費側の `.cargo/config.toml` へ
Windows path を basic string で書き、バックスラッシュ + `e` / `0` が
**不正エスケープで TOML parse error** になった。
**走行中の heavy gate が `could not load Cargo configuration` で落ちた**。

- **正しい形** = literal string（シングルクォート）か forward slash
- **手順** = config を触ったら **`cargo metadata --no-deps` が通ることを確認してから**
  gate を回す。**走行中の gate がある間は config を触らない**
  （bound source を触らない原則と同軸 — config は全 lane の共有 input）

## 参照

- `garelier-core/references/pm_field_manual.md#pmfm-3` — gate を dispatch する PM 側の決定表（gate 依頼正準形）
- `worker_field_manual.md` — review 対象を作る role 側の決定表
- `attended-gate-dispatch.md` — gate dispatch の完全 prompt template、report contract、high-stakes refuter
- `carabiners.md` — refuter (= `adversarial_verify` carabiner)・delta_gate・merge_review 等の任務形態語の正本（DEC-095）
- `templates/gate_verdict.md` — verdict marker 雛形（fail-closed parser contract を header に記載）
- Guardian / Observer SKILL + `references/` — verdict 意味 / review dimensions / redaction の正本

<a id="incident-container-mismatch"></a>

## §F. incident の記録先と、踏んだ席の container が食い違う時（W-655）

`GARELIER_RUNTIME_INCIDENT` を出した席と、その incident が書かれた container は**同じとは
限らない**。hook は host の incident root へ書くので、別 PM namespace の lane で踏んだ失敗が
その host の既定 PM の `runtime/hooks/` に載る。**「自分の container に無いから起きていない」
と読まない。**

読み方は 2 段:

1. marker が名指した path をそのまま開く。自分の container の path に読み替えない。
2. **繰り返しは coalesce される。** 同一原因の 2 回目以降は `incidents.jsonl` に**行を持たず**、
   `runtime/hooks/incident_repeats/<kind>_<hash>.json` の `count` だけが増える。
   したがって `incidents.jsonl` の行数は発生回数ではない。回数を数えるなら repeat record の
   `count` を読む。`first_at` / `last_at` / `last_incident_id` が同じ record に在る。

**分母を row の記載から取らない。** repeat record の `count` は起票後も増え続けるので、
row に書かれた件数は起票時点の snapshot である。census するなら HEAD の record を読み直し、
row 側を訂正する。
