# Codex worker playbook (Codex CLI を Garelier worker として使う)

Status: 実戦知見の蓄積中 (2026-07-07 開始)。
**codex 不調時は自力診断より先に本 playbook を rg する** (W-069 — stdin hang を
quota 枯渇と誤診した実例あり。答えは大抵もうここに書いてある)。
本 file は「Claude Code PM が Codex CLI を worker として dispatch する」構成の**一般正本**
(どの target project でも適用可)。規範部は project 非依存で書き、project 固有の実値は各 PM の
knowledge addendum に置く。知見が出るたび PM が「知見 log」へ日付付きで追記する。

## Model 運用方針 (user 確定 2026-07-07)

**Codex first**: worker task はまず Codex CLI へ (Pro rate は使い切って良い)。rate limit /
起動不能 / 品質不適合でその task に使えない時は **Opus / Sonnet の Claude worker に fallback**。
gate (Guardian/Observer) と PM は常に Claude 側。

## 構成 (検証済みの型)

```bash
# dispatch_prepare で通常どおり dispatch container + workbench worktree を作る
# prompt を self-contained な file に書く (下記「prompt 設計」)
skills/garelier-core/driver/src/scripts/dispatch_codex_producer.ts \
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
- **起動は必ず `dispatch_codex_producer.ts` 経由 (W-039)。素の `codex exec` は禁止** — worktree の
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
- **`danger-full-access` は Garelier に入れない。** `dispatch_codex_producer.ts` は
  `--sandbox danger-full-access` を拒否する。user が手動検証で一時承認した場合も、
  それは Garelier の恒久設定・helper・prompt へ転記しない。承認なしで cargo 等が必要な時は
  分業構成 (Codex 実装 / PM 検証) で代替する。
- sandbox 帰結: **sccache (workspace 外 cache dir) が使えない** → `RUSTC_WRAPPER=` で無効化し、
  checkout local の cold build を許容する。Rust の heavy compile を伴う task では build 時間 +
  RAM を見込む (RAM 律速の box では他 heavy lane と直列化 — 実値は project addendum 参照)。
- helper の `--result <file>` で最終 message を file 取得。dispatch container は
  `--add-dir` 付与済みなので、`report.md` / `codex_last_message.md` は container 直下でよい。
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

**Opus PM 向けの注意:** 本 playbook と pm_field_manual だけで運用が完結するように書いてある。
迷ったら「Codex は『実装だけする外部 worker』、検証と gate は常に Claude 側」とだけ覚えれば
判断を誤らない。rate 残量は user に聞くのが最速 (UI にしか出ない)。

**同時実行の制約 (2026-07-08 実測)**: Windows で `codex exec` を **2 instance 同時起動すると
片方が全 process spawn 不能 (1312) で即死**する事例 ×2 (単独再走では成功)。**codex worker は
直列 1 本运用** — 並列させたい時は 2 本目を Claude worker にする。

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

(option、未実装): `dispatch_codex_producer.ts` に `--probe` flag を足して手順 1 の低 effort
1 行 prompt probe を helper 側で標準化する案があるが、helper 変更は追加の検証コストを要するため
本 row では見送り — 上記コマンドを手で叩けば同じ確認ができる。

## prompt 設計 (Codex は Garelier skill を読めない — self-contained 必須)

必ず含める:
1. **作業 dir 規律**: checkout path 明示 + 「この dir の外を読み書きしない」(並走 lane 保護)
2. **push 禁止 / commit のみ / merge は PM**
3. 触ってよい領域と **並走 lane の禁止領域** (branch 並走が見えないため明示列挙)
4. task 正本 (backlog row 全文) + AC + gate command 列
5. commit message 形式 (`[#<id>]` + trailer `Garelier: <pm_id> worker#<id> <W-id>`)
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
  占有者 ≠ author の明示) を配布する。upstream opt-in (openai/codex #14338) が landed したら
  `--commit-mode self` / `GARELIER_EXTERNAL_SEAT_COMMIT=self` で自己 commit へ復帰。
- **1312 の真因確定 (2026-07-11)**: Store 版 (MSIX) PowerShell の activation stub を codex の
  Windows sandbox runner が spawn できない事が原因 (ERROR_NO_SUCH_LOGON_SESSION)。
  **解決 = 既存の MSI 版/portable `pwsh` を resolver で絶対パス選択**。見つからない場合は
  user-managed prerequisite として明示 BLOCK。Garelier は導入・更新・download を実行/提案しない。
  を指せば良い)。1312 に遭遇したら最初に `where pwsh` を確認する事。
- 2026-07-07 追試: **toolchain 実体 cargo.exe の直呼びでも 1312** (rustup shim が原因ではない)
  — workspace-write で cargo 系は構造的に不能と確定。bun は同 sandbox で動く (bun test 実証)。
  ただしこの履歴は Garelier が `danger-full-access` を使ってよい根拠ではない。現行方針は
  `workspace-write + --add-dir` helper 固定で、Rust 自己検証が sandbox で不能な場合は
  分業構成 (Codex 実装 / PM 検証) が正。
- 2026-07-07 #2 trial (garelier W-158, bash hook + bun test): **sandbox 内で bun test 自走成功**
  (targeted 8 pass)。ci.ts の bash -lc 全体は 1312 で不能 → PM が代行。bash/TS repo では
  「targeted test まで Codex 自走、full CI は PM」の分業
