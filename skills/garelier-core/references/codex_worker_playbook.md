# Codex worker playbook (Codex CLI を Garelier worker として使う)

> **claude-only 運用中は本書を読まない (W-690、user 裁定 2026-09-05)。**
> codex の利用は停止された。`dispatch_prepare` は `--provider` 省略時に `claude-code` を選び、
> codex は明示 flag でのみ選ばれる (`model_routing.md` § Framework initial value)。
> 本書は codex を再開する時のためだけに残す。provider 非依存の条文
> (REQUIRED GATE block / register 契約 / dispatch 宣言 3 軸 / ledger) は
> `worker_field_manual.md` が正本で、本書はその再掲でしかない。

## codex 固有経路の census (W-690 AC-2、2026-09-05)

分類は 3 値: **(a) 退役** / **(b) 両 provider 共通として維持** / **(c) claude 経路にも同じ穴**。
「使わないから放置」は分類ではない。**(a) は 0 件** — Fork E の裁定により codex 固有物は
削除しない (削除すると codex 再開時に同じ穴が開く row = W-687〜W-689 の情報が失われる)。

| 対象 | 分類 | 根拠 (実測) |
| :--- | :--- | :--- |
| `provider_session.ts` の codex-cli transport | **(b)** | 同 file が claude も駆動する — `SessionProvider = "codex-cli" \| "claude-code"`、`commandName = record.provider === "codex-cli" ? "codex" : "claude"`。codex 分岐を退役させると `claude-subprocess` transport の spawn / resume が同時に消える |
| `dock_proxy.ts` (PROXY mode) | **(b)** + (c) | `admitDockProxyReadyPaths` / `resolveDockProxyRegisterPath` は W-641 以降 **provider 非依存**で、`review_prepare.ts` が claude lane でも呼ぶ。codex 専用なのは proxy commit unit (`main`) だけ。(c) = register 解決が壊れると claude lane も落ちる (#355 / #437 の実害そのもの) |
| `dispatch_prepare_lane_commit_plan.ts` | **(b)** (dormant) | `context.routing.commit_mode !== "proxy"` で即 die。claude lane は `commit_mode: self` なので到達 0。W-689 (trailer 間の空行) の穴はここに在るので、削除ではなく row として残す |
| `codex_worker_playbook.md` (本書) | **(b)** | claude-only 運用中は読まない。provider 非依存の条文は `worker_field_manual.md` が正本 |
| `review_prepare_provider_parity_w641.test.ts` | **(b)** | 名前は parity だが実測対象は **claude lane の shape** (`routing` に provider が無い / `ready.json.provider_transport` / register = `<container>/report.md`)。codex 側は leaf 解決の 1 assertion のみ。claude-only 運用でこそ効く |
| `role_binding.ts` の Codex register 転記検査 | **(c)** | `transcribeCodexRegisterConsumption` は proxy commit 経路でしか走らない。claude 席は ledger を自分で書くので転記は不要だが、**「REPORTING 前に全 entry が checked」の enforcement 点が provider で非対称**: codex = admission (機械的に止まる)、claude = `contract_check --stall-scan` の UNCONSUMED-INSTRUCTIONS + 席の自己 lint (どちらも scan、PM が回す)。述語自体は `dispatch/instruction_ledger.ts` の 1 正本を共有しているので**判定は同じ**、違うのは**いつ誰が止めるか**。→ **本 row では直さない**。W-412 / W-688 が持つ |

Status: 実戦知見の蓄積中 (2026-07-07 開始)。
**codex 不調時は自力診断より先に本 playbook を rg する** (W-069 — stdin hang を
quota 枯渇と誤診した実例あり。答えは大抵もうここに書いてある)。
本 file は「Claude Code PM が Codex CLI を worker として dispatch する」構成の**一般正本**
(どの target project でも適用可)。規範部は project 非依存で書き、project 固有の実値は各 PM の
knowledge addendum に置く。知見が出るたび PM が「知見 log」へ日付付きで追記する。

## W-330 hot contract — completion, capability, and timeout

Codex-dispatched roles run through the recorded `codex exec` helper and complete through
its result/session files. Collect that running command or its durable broker
result; never substitute a collaboration child or poll an unrelated agent list.

Every timeout-capable command invocation specifies a finite caller timeout based
on its measured/declared budget and recovery plan. `garelier control` mutation
calls use at least 60 seconds; merge/land uses at least 120 seconds. A timeout is
not a retry signal: read canonical state before considering another mutation.
Never change child timeout environment/config as a substitute. `gpt-5.6-luna`
may be used for judgment-zero work only when an advertised selectable-model list
contains it; unavailable/unknown is Terra fallback, never an automatic probe or
guessed spawn. Parent temporary input belongs only under resolved
`control_root/__garelier/<pm_id>/runtime/tmp/`.

## Provider 選択の帰属 (2026-08-05 明確化)

**どの provider を優先するかは garelier framework の概念ではない** — provider/model の選択は
**project ごとに user と PM が決める運用裁定**であり、per-task の `--provider` / `--model` flag が
唯一の伝達経路 (fixed fallback なし、`model_routing.md` §Mechanized resolution)。
本 playbook は「project が task を Codex に routing した時」の実行手順の正本であって、
Codex を使うべきかどうかは規定しない。

(参考・project 裁定の実例: ある target project は 2026-07-07 に「worker task は Codex first、
rate limit / 起動不能 / 品質不適合で Claude worker へ fallback、gate と PM は Claude」と裁定した —
これは当該 project の運用であり、framework の既定ではない。)

## 構成 (検証済みの型)

```bash
# dispatch_prepare で通常どおり dispatch container + workbench worktree を作る
# prompt を self-contained な file に書く (下記「prompt 設計」)
skills/garelier-core/driver/src/scripts/dispatch_provider.ts \
  --provider codex \
  --worktree <dispatch checkout> \
  --project <control-root> \
  --target-root <target-root-if-Plant-Crust> \
  --prompt <container>/codex_prompt.md \
  --result <container>/codex_last_message.md \
  --sandbox workspace-write \
  --model <model> --effort high
```

- **`codex exec`** = 非対話 mode。prompt を渡すと自走して終了する。終了 = harness の完了通知
  (bg 実行時) — Claude worker の「turn 終了停滞」問題が構造的に無い (process が生きている限り
  走り続ける) のが最大の運用上の違い。
- **起動は必ず `dispatch_provider.ts --provider codex` 経由。素の `codex exec` は禁止** — worktree の
  `.git` は main repo を指すため、`--add-dir` grant を欠く素叩きは全 process spawn が
  `CreateProcessAsUserW 1312` で死に、「sandbox 障害」に見える (2026-07-10 の誤診事例)。
  `dispatch_prepare` が codex seat の時に ready-to-run の `launch_cmd` を JSON で発行し、
  command_guard の `codex_raw_exec` rule が素叩きを ask で止める (read-only probe は許可)。
- **`--sandbox workspace-write`** を標準とする。helper は `--add-dir` を機械的に付与する:
  project/control root、dispatch checkout、dispatch container、result dir、Garelier skills root、
  Plant-Crust target root、`context.json` が示す project/target root、明示 `--add-dir`、
  **`$CODEX_HOME/skills` (W-062 で helper が既定 read grant、3c2551c — 旧「per-dispatch で
  `--add-dir ~/.codex/skills` を足す」workaround は不要になった。新 codex 版の skill-loader
  fatal 対策)**。
- **write grant と注入 prompt は同じ範囲を述べる (W-485、2026-09-03)。** `--add-dir` の write
  grant (`codexProviderWritableRoots` = worktree + container + result dir + bun dir) は
  **container 直下の canonical artifact** (`report.md` / `STATE.md` / `instructions.md` /
  launcher result) を含む — role が報告するとはそれらを書くことだからである。注入 prompt は
  以前「**NEVER create/edit/delete files, outside your worktree cwd**」と述べており、grant が
  許すものを prompt が禁じていた。文面を grant に合わせた (grant は縮めない、PM 裁定 FORK-F):
  書けるのは **worktree** と **container 直下の上記 artifact だけ**で、container のそれ以外・
  primary checkout・共有 gitdir・未列挙 path は今も sandbox が拒否する。
- **`danger-full-access` は Garelier に入れない。** `dispatch_provider.ts` は
  `--sandbox danger-full-access` を拒否する。user が手動検証で一時承認した場合も、
  それは Garelier の恒久設定・helper・prompt へ転記しない。承認なしで cargo 等が必要な時は
  分業構成 (Codex 実装 / Dock gate) で代替する。
- sandbox 帰結: **sccache (workspace 外 cache dir) が使えない** → `RUSTC_WRAPPER=` で無効化し、
  checkout local の cold build を許容する。Rust の heavy compile を伴う task では build 時間 +
  RAM を見込む (RAM 律速の box では他 heavy lane と直列化 — 実値は project addendum 参照)。
- **heavy_compile_lock は codex prompt から直接叩かせない (W-224、2026-07-27 実害の是正)。**
  `heavy_compile_lock.ts` は `garelier-core` framework repo 側 (`skills/garelier-core/scripts/`)
  にあり、target project とは別 repo — codex worker の worktree/container は自身の project の
  `--add-dir` grant しか持たないので、フルパスが正しくても別 repo への cross-repo read は
  **到達不能** (`EPERM reading` になる。パスが古い/誤りだと `Module not found` が先に出る)。
  `dispatch_prepare --provider codex` は既にこれを解決済み: 生成される prompt preamble
  (`lane_common.ts` の `requiredGateDelegationContract()`、codex 側の理由句付き) は
  「sandbox は heavy_compile_lock を取れないので自分で required project gate を走らせるな」と
  明記し、代わりに worker は REQUIRED GATE ブロックで Dock 席に委譲する。
  **ブロックの書式・必須性・PM 選定 step の規約は provider 非依存で
  [`worker_field_manual.md` §5b](worker_field_manual.md) が正本** (W-641)。ここでは
  codex 固有の事情 (sandbox が lock を取れない) だけを記す。
  `--provider codex` は task authority であり、`setup_config.toml` の
  `[[workers]]` 等の role/container metadata は provider/model/effort を選ばない。
  model/effort は explicit task flag → blueprint hint → `[model_routing]`
  fallback の順で解決し、固定 seat/roster へ戻さない。
  **codex prompt を手書きする時は絶対にやってはいけないこと**: `heavy_compile_lock.ts` を
  garelier repo の絶対パスで直接呼ばせる指示を書く (worktree/container 内に無い限り読めない、
  --add-dir も無い)。正しい書き方は `codexProviderContract` が emit する文言をそのまま使うか
  (dispatch_prepare 経由が正)、手書きが必要なら
  [`worker_field_manual.md` §5b](worker_field_manual.md) のブロック様式を丸ごと転記する。実害: 実戦の target project で起きた実例 (2026-07-26、target project PM が手書き prompt で
  `garelier-core\driver\src\scripts\heavy_compile_lock.ts`（存在しない旧パス想定）を直接叩かせる
  指示を書き、worker が `Module not found` → 発見した正パスも `EPERM reading` で完全 BLOCKED した)。
- **既存 tracked file の write-open 拒否 (W-224、2026-07-27 実測、upstream 未修正)**: 新規 file は
  作れるのに、worktree 内の**既存の** tracked `.rs` (例: `phase.rs` / `spawn.rs`) を開いて書こうと
  すると `Access to the path '...' is denied` になることがある — `icacls` では read-only 属性なし
  ・inherited Modify あり、なのに write-open は拒否される非対称。openai/codex 側の複数の未解決
  report と同型 (#15165 "does not recursively grant usable ACLs to existing workspace files" /
  #32649 / #18918・#32880 は `.git` 版): 「sandbox セットアップが workspace root へ継承可能な ACE
  を足すが、既にあった descendant ファイルの ACL は遡って直さない」ため、ACE 追加**後**に作られた
  file は継承で通り、ACE 追加**前**からある file は古い ACL のまま拒否され続ける。
  `dispatch_provider.ts --provider codex` はこの緩和を機械化済み: 起動直前に
  `icacls <worktree> /reset /T /C /Q` を best-effort (win32 のみ、失敗しても dispatch は止めない)
  で実行し、既存 descendant を「親から継承」に戻すことで root の ACE を拾わせる
  (`repairWorktreeAclSync`、`dispatch_codex_provider_acl.test.ts` で検証)。**それでも解決しない
  場合** (upstream バグ自体は未修正、確実な回復保証はない): 上の「Rate limit 枯渇時の運用」と同じ
  fallback 手順 (同じ prompt file を Claude worker (Opus/Sonnet) にそのまま渡す) を使う —
  Claude worker はサンドボックスされないのでこの class の denial に遭遇しない。
- 共通 launcher の `--result <container>/lane/result.md` は provider の最終応答を
  1 回上書き保存する。role はこの capture file を途中で書かず、最終応答に blueprint の
  `Output definition` 全項目を含める。失敗時は launcher が同じ path を
  `provider result unavailable` で上書きし、古い成功結果を残さない。
- **この capture file が stall 判定の入力でもある。** watch は lane 自身の宣言を読み、
  `lane/result.md` の 1 行目が canonical grammar (`STATE=REPORTING` / `STATE=BLOCKED`、
  任意で `; ` + 同一行の詳細) なら停滞ではなく `DECLARED-DONE` と判定する。
  だから最終応答の**1 行目**は必ずこの形にする — `STATE: …` / 2 行目以降 / 小文字 /
  未知の state は宣言と認められず、完了済 lane が停滞として上がる。
  **capture file が在る間はそれが正本**で、STATE.md では上書きできない
  (壊れた provider result が STATE.md 経由で「完了」に化けないため)。
  Agent tool で起こす Claude 席はこの launcher 経路を通らないので、
  その場合だけ STATE.md の Status 見出しが宣言の担い手になる
  (2 経路が同じ artifact を作らない件自体は W-636 が扱う)。
- read-only gate seat の verdict path も同じ launcher capture であり、永続 artifact を
  先に置く file ではない。Guardian / Observer は verdict と findings の全文を最終応答として
  返す。「別 file に記録した」という自己参照だけを返すと、その短い応答が verdict path を
  上書きして本文を失う。PM は capture が不自然に短い場合、provider job output から完全な
  応答を回収して gate 判定を止めたまま seat へ再提示する。

結果と gate の接続は provider に依存しない:

```text
role final response
  -> <container>/lane/result.md
  -> gate_runner.ts --from-register <container>/lane/result.md
  -> declared register steps
  -> project-declared terminal closure
```

`lane/result.md` は transport と gate の入力であり、永続的な設計判断や詳細な作業記録の
保存先ではない。それらは `report.md` / `STATE.md` / role artifact に置く。ただし blueprint が
最終応答へ evidence を要求した場合は、その全量を `lane/result.md` に含める。progress register の
`POINTER + DELTA` は進捗 message と永続 file への pointer にだけ適用し、captured final response の
必須項目を省略する根拠にはならない。

最小の provider result 形 (REQUIRED GATE block の規約は
[`worker_field_manual.md` §5b](worker_field_manual.md) が正本。ここは codex の
COMMIT PLAN と組んだ配置例):

```toml
+++
[lane]
state = 'REPORTING'
branch = '<role branch>'
report = '<report path>'
gate = '<scoped result; required full gate delegated>'

# 消化した canonical instruction ごとに 1 table。
# 値は TOML string なので括弧・backtick・改行は普通の文字。言い換え不要。
[[instruction]]
id = 'I1'
digest = '<12 hex>'
consumed = '''artifact:<project-relative-path> または commit:<40hex>'''
+++

<blueprint Output definition の全必須 evidence>

=== REQUIRED GATE (Dock-run) ===
<one executable project-declared command per line>
=== END REQUIRED GATE ===
<commit plan when required>
```

最小の read-only gate seat 最終応答形:

```toml
+++
[verdict]
result = '<canonical verdict token>'
review_sha = '<reviewed SHA>'
+++

<complete findings and required actions; no self-referential pointer>
```
- reasoning effort は `-c model_reasoning_effort="high"` (Pro rate を使う承認がある時)。
- **`--model` は config の許可名のみ (ChatGPT account)**: `~/.codex/config.toml` の
  `model` (例 `gpt-5.5`) が account で許可された名前の正本。それ以外の推測名 (例
  `gpt-5.5-codex`) は `invalid_request_error: not supported when using Codex with a
  ChatGPT account` で即死する (2026-07-10 実測 — flag 自体は有効、名前が問題)。
  通常は無指定 = config 値 (model + model_reasoning_effort) に任せるのが正。

## Rate limit 枯渇時の運用 (Codex 5h window が 0 になった時 — Opus/Sonnet PM 向け完全手順)

ChatGPT Pro の Codex は 5 時間 rolling window + 週次 cap の 2 段 rate limit を持つ
(観測: 対話 UI に「5H 使用量」表示。正確な閾値/リセット仕様は OpenAI 公式が正 —
挙動が変わったら本節を実測で更新する事)。

**枯渇の検出 (実測ベースの手順):**
1. `codex exec` が短時間で異常終了し、stderr/最終 message に usage / rate limit 系の
   文言が出る (正確な文言は版で変わる — 「すぐ死ぬ + limit 言及」で判定)
2. 判別に迷ったら probe。**probe の正準形 (W-069、2026-07-13 誤診事例の教訓)**:
   `codex exec -m gpt-5.6-terra -c model_reasoning_effort=low --sandbox read-only "Reply OK" </dev/null`
   — **foreground** で、**`</dev/null` で stdin を閉じ**、低 effort 1 行で。bg 起動 probe は
   stdin 未閉鎖で「Reading additional input from stdin...」hang し、quota 枯渇と誤診させた
   実例がある (PM が probe 自体を bg にして hang を rate 切れと読んだ)。
   が失敗するなら rate 起因とみなす (task 側の問題と切り分けられる)

**枯渇時の fallback (user 方針 2026-07-07「使えなくなったら opus/sonnet で進めて」):**
1. **同じ prompt file をそのまま Claude worker に渡す** — codex_prompt.md は self-contained
   に書いてある (本 playbook の設計原則) ので、Agent tool (subagent_type: general-purpose、
   model: opus または sonnet) に「Garelier Worker role。<prompt file の内容>」で dispatch
   すれば同一 task が続行できる。dispatch container / branch はそのまま流用
   (Codex が途中 commit を残していれば引き継ぎ、無ければ最初から)
2. Claude worker には追加で通常の worker 規約 (worker_field_manual + 長走 gate は
   1 script + run_in_background) を付ける — Codex prompt には無い項目
3. **復帰**: 5h window 回復後に Codex へ戻す (次の新規 dispatch から。走行中の Claude worker
   を中断してまで戻さない)。回復確認は上記 probe で
4. 品質差の目安 (2026-07-07 時点の実測): Codex は実装 + 正直な report が堅実、
   sandbox 制約で自己検証不能 → どちらの model でも **gate (Guardian/Observer) は不変**。
   fallback しても品質保証の枠組みは同じ

**Opus PM 向けの注意:** 本 playbook と `garelier-core/references/pm_field_manual.md#pmfm-0` だけで運用が完結するように書いてある。
迷ったら「Codex は『実装だけする外部 worker』、検証と gate は常に Claude 側」とだけ覚えれば
判断を誤らない。rate 残量は user に聞くのが最速 (UI にしか出ない)。

**stdin 待ち hang (2026-07-10 実測)**: bg 実行で stdin を閉じないと `codex exec` が
「Reading additional input from stdin...」のまま**永久待ちで hang する事がある** (process は
生存、log 1 行のみ、成果物なし)。**起動時は必ず `< /dev/null` で stdin を閉じる**。
過去の「silent 死」の一部はこれ (rate 枯渇と誤診しうる — process 生存なら stdin hang を疑う)。

**枯渇時の実挙動 (2026-07-07 実測)**: `codex exec` は **error 文言を出さず静かに終了**する事がある
(log 最終行が「Reading additional input from stdin...」のまま、commit も report も無し)。
exit code や stderr に頼らず、**「成果物 (commit/report) の不在」で枯渇を疑い、probe で確定**する。
5h window の回復時刻は UI にのみ表示される (user に聞く) — 実例: 使用 0% → 当日 0:24 JST 回復。

## quota 運用の 3 手順 (workshop W-052、target project 実戦 2026-07-11/12 — quota 枯渇 2 回)

上記「枯渇の検出」「枯渇時の fallback」を、大型 wave の途中で quota window を跨いだ実例から
3 手順に具体化する。

1. **枯渇の signature = silent 3-line exit-1**: 大型 wave 実行中に `codex exec` が
   **3 行だけの出力で exit code 1 のまま静止**したら、まず quota 枯渇を疑う (task 内容の
   エラーではなく、window 跨ぎで rate が尽きたことの表面化であることが多い)。上記の
   `--sandbox read-only "1+1 を..."` 低 effort 1 行 probe で即座に確定する — probe も
   同様に死ぬなら quota、probe だけ通るなら task 側の問題。
2. **大型 wave は quota window 跨ぎでの mid-run 死を前提に設計する**: 5h rolling window +
   週次 cap の合成のため、ファイル数の多い wave (実例: E1 級 wave が 152 file 処理中に
   mid-run で死亡) を window の終盤に投入しない。**quota リセット直後に大型 wave を投入する**
   のが安全 — リセット時刻は user に確認する (UI にのみ表示、上記「枯渇時の実挙動」参照)。
3. **mid-run 死からの標準復旧**: (a) 部分成果を **file 単位で監査** する — 何 file が
   意図通り編集されたか、途中で壊れた/半端な編集が無いかを確認する。**fmt 汚染
   (未整形コードが commit 予定 diff に混ざる) が典型的な汚損パターンなので revert 候補として
   個別に見る**。(b) 監査で救えた分を土台に、**Claude (Opus/Sonnet) 継続 seat へ handover** して
   残りを完走させる — 具体手順は上記「枯渇時の fallback」+ W-051 (seat handover context 追随)
   と連動する。手動 `--seat-trailer checked` で回避した場合は監査痕跡が薄くなるので、
   `merge_land.ts` の `--require-seat-trailer` 前提が崩れていないか W-051 landing 後に確認する。

(option、未実装): `dispatch_provider.ts` に `--probe` flag を足して手順 1 の低 effort
1 行 prompt probe を helper 側で標準化する案があるが、helper 変更は追加の検証コストを要するため
本 row では見送り — 上記コマンドを手で叩けば同じ確認ができる。

## prompt 設計 (Codex は Garelier skill を読めない — self-contained 必須)

必ず含める:
1. **作業 dir 規律**: checkout path 明示 + 「この dir の外を読み書きしない」(並走 lane 保護)
2. **push / git add / git commit / git stash 禁止** — commit plan を report に書き、Dock が proxy-commit
3. 触ってよい領域と **並走 lane の禁止領域** (branch 並走が見えないため明示列挙)
4. task 正本 (backlog row 全文) + AC + gate command 列
5. commit plan の message 形式 (`[#<id>]` + trailer `Garelier: <pm_id> worker#<id> <W-id>`)
6. report の書き先と内容 (実装仕様 / SHA / gate 結果 / 迷った点の率直な報告)
7. **target project の CLAUDE.md から違反即 gate-fail の規約を抜粋して埋め込む** (例: 特定 crate
   経由の import 強制 / 命名 prefix の runtime 判定禁止 / 防御層の配置規約など — Codex は
   CLAUDE.md ancestry を読まないので prompt に直接書く)

## Claude Code 側の受け (PM の作法)

- Codex は SendMessage/STATE.md 遷移を扱えない → **register 相当 = report file + 完了通知**。
  STATE/manifest 整合は PM が collect 時に代行する。
- gate (Guardian/Observer) は通常どおり Claude 側で dispatch — Codex 成果物も同一基準。
- fleet_watch の状態機械には乗らない (STATE.md が無い) — 監視は bg process の完了通知 +
  codex process の存在確認 (`tasklist | grep codex`)。

## plugin との関係 (2026-07-07 検証)

- `openai/codex-plugin-cc` plugin の `codex` agent type は **Claude (Opus) で動く wrapper**
  (probe 実測: model=Opus 4.8)。GPT compute は中で CLI を叩く部分だけ。
- → **worker 用途は CLI 直叩きが正** (wrapper 層の Claude token を節約)。plugin の価値は
  LSP server / 対話 command 側。

## 知見 log (時系列、PM が追記)

- 2026-08-11 Rust target project #543-557 実戦 (codex 8 lane 連続運用) の集約知見:
  - **600s timeout の正体は複合で、codex 仕様の恒久壁ではない**: (a) garelier の `context.json` が
    `bash_timeout_budget_ms=600000` を advisory 供給し codex がそれに従う (我々の設定)、
    (b) codex の組み込み shell/exec timeout は **model が per-call で指定する方式**で、公式
    config-reference (learn.chatgpt.com/docs/config-file/config-reference) に恒久 config key は
    **非文書化** (MCP 用 `tool_timeout_sec` は shell に非適用)。**10 分超の command は
    background terminal (起動 → `write_stdin`/poll → 回収、`background_terminal_max_timeout`
    既定 300000ms/poll) が公式の正規手段**。恒久対応 = W-402 (per-task budget flag +
    preamble への background-terminal 手順)。
  - **launch.json (`generation-N/launch.json`) は launcher が provider exit 後に書く** — worker が
    自 session 走行中に自分の launch ack 不在を BLOCK 理由にした誤 premise が 2 lane で発生
    (#543/#547)。task file に「BLOCK 条件にしない」を明記するまで再発した。恒久解は preamble
    への組込みが望ましい (W-402 と同梱可)。
  - **studio と base の control-only 数 commit 差を codex が preflight BLOCK にする** (#546) —
    「code path に重なる差分がある場合のみ BLOCKED」を task file に明記して回避。また
    **prepare → launch の間に PM が studio へ commit しない** (base 差を自分で作らない)。
  - **codex は scoped self-gate (cargo check/test -p) を省略して未検証提出しがち** (#544 が
    compile error 3 件のまま提出 → rework lane 1 本消費)。task file に「自走 gate 必須、
    cold build でも実走。full-workspace のみ PM 委譲」を毎回明記する。
  - **role binding は単回消費** — launch 済み generation への `provider_session resume` は
    `role_binding_invalid` / dispatch_prepare は `launch replay refused` になる。BLOCKED →
    回答 → 再開は **fresh dispatch + cherry-pick** が現行の正規経路 (rebind 機構なし)。
  - fresh worktree は cold build。sccache は repo の `.cargo/config.toml` 経由で非 codex lane に
    効くが **codex sandbox は cache dir 不達で常に cold** — 長い task ほど分業 (codex 実装 /
    PM・Claude 検証) が効く。worktree 横断 hit の改善候補 = `SCCACHE_BASEDIRS` の per-lane
    注入 (W-401、mozilla/sccache#2595 により static 設定では不成立)。
  - **gate (Guardian/Observer) は codex に置かない**: sandbox で実行検証 (test 再実行・scanner)
    が構造的に完走せず、provider=codex 主流下では gate=Claude の heterogeneous 構成が
    同族盲点の相関を切る (PM 裁定 2026-08-11)。

- 2026-07-07 #210 (Rust target project の cooker validator + fixture task) **完走 → merge 到達**:
  - **Windows workspace-write sandbox では cargo/rustc/rustfmt が spawn 不能**
    (`CreateProcessAsUserW failed: 1312`) — Rust task は **Codex 実装 / PM(Claude) 検証** の
    分業が必須。fmt drift も PM が `cargo fmt` 補正 commit で吸収する
  - 品質: 実装構造・error message・fixture 設計は堅実 (Observer 評)。「gate 未実行」を
    正直に report した (over-claim なし)
  - 当時の raw `codex exec` では checkout 外 (container 直下) への report 書込が拒否された。
    現行 helper は dispatch container / result dir を `--add-dir` 付与するので、report 先は
    container 直下でよい。
  - gate は通常どおり有効: Guardian PASS (gitleaks 込み) / Observer が変換の数理まで検証、
    初回 REWORK → PM の反証照合 (production 実 code cite) → 再照合で PASS_WITH_NOTES に更新。
    **外部 model 産 code ほど Observer の独立再導出 + PM の反証往復が効く**
  - fleet_watch は codex dispatch の STATE.md を検出して false-positive を出す →
    register_received touch で抑制 (恒久対応 = W-034 検討: external dispatched-role marker)
- **worktree では commit 不可 (2026-07-11 確定、upstream 制限)**: codex sandbox は writable
  root 配下の `.git` を再帰的に read-only 保護し、`--add-dir <project>/.git` でも突破不可
  (openai/codex #15505 / #7071)。worktree の gitdir は project/.git/worktrees/ 配下のため
  merge/commit が Permission denied になる。**運用 = commit-plan 分業**: codex は編集 +
  gate 実行まで、report に commit 分割案 (message 完全形 + file 列挙) を書き、PM が外側から
  適用する。**W-042 で機構化済み**: `dispatch_prepare` が codex seat に `commit_mode=proxy`
  を既定発行し、preamble が git add/commit/stash 禁止 + commit plan 様式 + 必須 provenance
  trailer `Garelier-Seat: codex <model> (proxy-commit via dock seat)` (committer = dock 座席
  占有者 ≠ author の明示) を配布する。現行 proxy floor は fail-closed で、
  `--commit-mode self` / `GARELIER_EXTERNAL_SEAT_COMMIT=self` は id/branch/worktree mutation 前に拒否する。
  upstream opt-in (openai/codex #14338) が landed しても自動では切り替えず、自己 commit の再導入には
  recorded decision + 実装変更 + gate が必要。
- **1312 の真因確定 (2026-07-11)**: Store 版 (MSIX) PowerShell の activation stub を codex の
  Windows sandbox runner が spawn できない事が原因 (ERROR_NO_SUCH_LOGON_SESSION)。
  **解決 = 既存の MSI 版/portable `pwsh` を resolver で絶対パス選択**。見つからない場合は
  user-managed prerequisite として明示 BLOCK。Garelier は導入・更新・download を実行/提案しない。
  を指せば良い)。1312 に遭遇したら最初に `where pwsh` を確認する事。
- 2026-07-07 追試: **toolchain 実体 cargo.exe の直呼びでも 1312** (rustup shim が原因ではない)
  — workspace-write で cargo 系は構造的に不能と確定。bun は同 sandbox で動く (bun test 実証)。
  ただしこの履歴は Garelier が `danger-full-access` を使ってよい根拠ではない。現行方針は
  `workspace-write + --add-dir` helper 固定で、Rust 自己検証が sandbox で不能な場合は
  分業構成 (Codex 実装 / Dock gate) が正。
- 2026-07-07 #2 trial (garelier W-158, bash hook + bun test): **sandbox 内で bun test 自走成功**
  (targeted 8 pass)。ci.ts の bash -lc 全体は 1312 で不能 → Dock 席が代行。bash/TS repo では
  「targeted test まで Codex 自走、full CI は Dock gate」の分業
- **2026-07-27 W-224 (user 裁定「相性が悪いから使わないはありえない」)、実戦の target project 実例の
  premise 反証**: worker が「heavy_compile_lock 到達不能」「既存 tracked .rs の write-open 拒否」の
  3 blocker を報告したが、うち 2 件 (heavy lock 到達不能・framework helper 不可読) は**既存機構
  (`codexProviderContract` の REQUIRED GATE 委譲 + `gate_runner.ts`、W-157/#361) が既に解決済み**
  だった — 実際の prompt は `dispatch_prepare` を経由しない**手書き** prompt.md で、
  存在しない旧パス (`garelier-core\driver\src\scripts\heavy_compile_lock.ts`) を worker に直接
  叩かせる指示を書いていた。**本 playbook にこの委譲機構の記載が無かった**ことが手書き誤りの
  実因と判断し、本節 (「構成」の heavy_compile_lock 2 項目) に追記した。**教訓: 「sandbox 到達不能」
  に見えても、既存機構で解決済みでないか本 playbook + `lane_common.ts`/`gate_runner.ts` を先に
  確認する (真因を鵜呑みにしない)。** 残る 1 件 (既存 tracked file write-open 拒否) は upstream
  未修正のバグ (openai/codex #15165 等) と特定し、`dispatch_provider.ts` に best-effort ACL
  repair (`repairWorktreeAclSync`) を追加、それでも解決しない場合の fallback (Claude worker 引継ぎ)
  を明記した。実 codex 再現検証は次の codex lane で PM が行う (本 row は構成の正しさを test で証明)。
  **追記 (同日、user 再指摘「知識は decision point で渡らないと意味がない」)**: 本節への文書化だけ
  では PM の記憶頼みが再発しうる (今回の実害そのもの) ため、`dispatch_prepare --provider codex` の
  JSON 出力に `codex_knowledge.read_first` (本 playbook への絶対 pointer + 1 行要約) と
  `codex_knowledge.dock_gate_commands` (この dispatch の `quality_gate[default_gate]` — codex が
  自走できず Dock 席が `gate_runner.ts --from-register` で代行すべき正確なコマンド列) を機械同梱した
  (W-224)。加えて `--task-file`/rendered assignment の本文が `heavy_compile_lock.ts` や
  `garelier-core/scripts|driver` への直接呼び出しを含む場合、`dispatch_prepare` 自体が
  fail-closed で BLOCK する (`CODEX_FORBIDDEN_DIRECT_INVOKE`)。**ただしこの実例は
  `dispatch_prepare` を経由しない手書き prompt だったため、この BLOCK では捕捉できない** —
  手書き prompt 経路そのものの drift 検出は別行 (W-226) で追跡中。garelier-pm SKILL.md の
  「Role dispatch pre-read」表にも provider=codex の横断行 (役に依存しない) を追加した。

- 2026-08-12 codex gate seat (Guardian) 実戦知見 — Rust target project + garelier repo の 2 面運用で確立:
  - **席割り合意 (user 裁定)**: Worker / Scout / Guardian = codex 固定、Observer = codex or claude
    (PM 判断)。provider=codex の時に Observer を claude 側へ置くと substrate 盲点の独立性が取れる
    (推奨であって強制でない)。
  - **codex Guardian の実行形**: `dispatch_prepare.ts` が出力した共通
    `dispatch_provider.ts --provider codex` command をそのまま使う。launcher は成果物 directory を
    cwd + 唯一の `--add-dir` にし、repository は read context のまま write grant しない。
    **model と effort は必ず明示** (省略すると config default 任せになり選定記録が壊れる — 発行値=実走値の
    監査線は gate 席にも適用)。
    **prompt は stdin 供給が必須** — 引数渡しは "Reading additional input from stdin..." のまま
    hang する (実測)。`read-only` sandbox は provider TLS を `UnknownIssuer` で落とす実測があるため
    強制しない。repository 保護は cwd / `--add-dir` grant の境界で行う。
  - **scanner は PM が機械代行**: gitleaks / `guardian_scan.ts` は成果物 directory だけを grant した
    seat から実行不能 — `block_when_required_scanner_unavailable` の方針上、codex 席単独では axis 1 が
    常に BLOCK になる。PM が `guardian_scan.ts --scope diff --out <json>` を先に走らせ、
    結果 JSON の要点 (scan_state / findings) を prompt に添付し、**判定だけを codex に委ねる**。
  - **verdict file は gate role 自身が作成** (DEC-090 — PM は書かない): codex gate seat は
    完全な role artifact を最終回答として返し、trusted launcher が authorization に束縛された
    result path へ直接保存する。PM は転記・編集しない。artifact 冒頭に seat / launcher-captured
    result path / scanner evidence の provenance を明記する。marker は front matter の `[verdict] result` の
    token と `[verdict] review_sha` を備え、merge gate の auto-read に適合させる。
  - **有効性の実測**: 初回実戦で per-segment 検証の欠けた path 証明 (traversal / symlink /
    namespace-escape で偽装可能) を REWORK として検出し、修正 (canonicalize → regular-file →
    namespace 封じ込めの順) と negative test 3 本に接続した。閉じた checklist を超える境界系の
    指摘が出る = gate 席として成立。
  - 揺れ: one-shot 中に「実行ホスト起動失敗 → 再接続」の transient が出ることがあるが完走した。
    再発が続く場合は間隔を置いて 1 回だけ再試行し、2 連続失敗で claude gate に切替える。

## register 契約 (W-668)

**正本 = `worker_field_manual.md` §5b-1 の表** (件数もそこが持つ — 本書に転記しない)。
codex 席でも claude 席でも同一で、provider による差は無い。ここでは codex 席で特に
踏みやすい 2 件だけを再掲する (残りは §5b-1 を読む):

- `bun test` の positional は `*.test.ts` / `*.spec.ts` の **file 列挙のみ**。
  self-contained prompt に「directory を渡してよい」と書かない。
- control doctor は **bun 形**。`garelier control doctor …` の shim 形は
  codex sandbox の PATH に無く、STEP は計画されて実行段で RED になる。

proxy 転記席が書く `consumed` だけは `artifact:<path> | commit:<40hex>` 形が要る
(producer 自身が書く ledger は非空なら何でもよい)。

`consumed` の中でも散文中でも、**完全 40 桁 SHA の出現は binder の拒否条件ではない**
(W-708 / DEC-100 裁定 2 — 旧 prose scan と除外 list は廃止)。recovery result の
`GARELIER_RUNTIME_STATUS` も**位置・個数を検査しない**; COMMIT PLAN の envelope
(`=== COMMIT PLAN ===` が 1 個 / `=== END COMMIT PLAN ===` が最終非空行) と
role identity trailer は proxy 契約として従来どおり検査される。

---

## REQUIRED GATE の PM 選定 step (2026-08-30、正本は移設済 2026-09-02)

**この節の内容は provider 非依存につき
[`worker_field_manual.md` §5b](worker_field_manual.md) へ移設した (W-641)。**
codex / claude のどちらの席でも同じ形で書く。ここに重複条文は置かない。

- codex 固有の残り 1 点: register は **worktree が clean で最終**の時だけ出す。追補指示の作業中に
  register すると Guardian が「是正が review SHA に無い」で BLOCK する
  (proxy commit 経路では worktree の dirty が commit plan と食い違うため実害が出やすい)。
## dispatch 宣言 3 軸

`--resource-class` / `--heavy-tier` / `--touches` の正本は
[`dispatch_env.md#dispatch-declaration-axes`](dispatch_env.md)。codex 席でも claude 席でも
同じ宣言を使う (provider 差なし)。heavy 宣言なしで heavy dispatch を出すと `context_pack` が
stderr に warning を出し、その文言が正本の節名を含む。

## REPORTING 前の ledger 自己検査

codex 席でも claude 席でも同じ。REPORTING に入る前に 1 回走らせる:

```bash
bun skills/garelier-core/driver/src/scripts/instruction_ledger_lint.ts \
  --ledger <container>/instructions.md --register <container>/lane/result.md
```

条文の正本は [`worker_field_manual.md` §6](worker_field_manual.md)。codex 固有の注意は 1 点 —
proxy commit 経路では register の `(consumed: …)` 行が transcription の入力になるので、
内側に `(` が入ると evidence 値が切れて **最初の 1 件しか転記されない**。lint はその行を
`BAD-CONSUMED-LINE` で名指す。**lint は直さない**、直すのは席自身である。
