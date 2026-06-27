# Changelog

All notable changes to Garelier are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Bilingual note / 言語について.** Entries from this release onward are written
> in both English and Japanese (日英併記); existing entries below remain in
> English. / 本リリース以降のエントリは日英併記で記載します。過去のエントリは
> 英語のままです。

## [Unreleased]

## [2.8.4] - 2026-06-27

Role-efficiency and blueprint automation release (DEC-084 / W-017..W-021):
PM-authored pipeline packages become mechanically plannable, role pickup context
gets compact generated packs, review/gate handoffs gain deterministic prep
surfaces, and Status Web exposes package/task workflow progress. / ロール効率化と
blueprint 自動化リリース (DEC-084 / W-017..W-021): PM が書く pipeline packages
を機械的に計画でき、各ロールの pickup context を compact pack 化し、review/gate
handoff の deterministic prep と Status Web の workflow 可視化を追加。

### Added

- Blueprint `Pipeline packages` (DEC-084) can now be parsed, validated,
  dry-run/tree migrated, and rendered into role `assignment.md` files with
  `skills/garelier-core/driver/src/pipeline_packages.ts`. `dispatch_prepare`
  accepts `--pipeline-package PP-N` for commit-producing dispatch containers.
  Existing public blueprints without the section remain valid. / Blueprint
  `Pipeline packages` (DEC-084) を追加。解析・検証・単体/一括 dry-run 移行・
  role `assignment.md` 生成が可能になり、commit-producing dispatch container では
  `dispatch_prepare --pipeline-package PP-N` が使えます。既存公開 blueprint は
  section なしでも引き続き有効です。

- `pipeline_plan.ts` lists and validates package readiness, dependencies, role
  routing, and exact dispatch/render commands. / `pipeline_plan.ts` が package
  readiness、依存、role routing、dispatch/render コマンドを一覧・検証します。
- `role_pickup_pack.ts` and dispatch/read-only prep wiring generate compact
  advisory pickup packs for Worker, Scout, Smith, Artisan, Librarian, and
  Concierge flows. / `role_pickup_pack.ts` と dispatch/read-only prep wiring が
  Worker/Scout/Smith/Artisan/Librarian/Concierge 向け compact pickup pack を生成します。
- `review_gate_prep.ts` prepares Observer review briefs, Guardian scan drafts,
  and Smith hardening briefs without giving those roles a verdict. /
  `review_gate_prep.ts` が Observer brief、Guardian scan draft、Smith hardening
  brief を準備します。判定は各ロールに残ります。
- Status Web now exposes `/api/workflow` and a Work / Workflow tab for
  read-only package/task progress visibility. / Status Web に `/api/workflow`
  と Work / Workflow tab を追加し、package/task progress を読み取り専用で可視化します。
- `role_doc_diet.ts` reports role entrypoint/reference size and missing compact
  first-read hooks as warning-only maintenance data. / `role_doc_diet.ts` が
  role entrypoint/reference size と compact first-read hook の不足を警告として報告します。

### Changed

- `dispatch_prepare.{sh,ps1}` includes pipeline package identifiers in
  dispatch events and emits pickup packs when assignments are prepared. /
  `dispatch_prepare.{sh,ps1}` は dispatch event に pipeline package ID を含め、
  assignment 準備時に pickup pack を出力します。
- Read-only assignment preparation now supports Scout-style non-commit work and
  inspection skeletons, keeping Garelier usable for routine work and automated
  testing beyond code changes. / read-only assignment prep が Scout 型の
  non-commit 作業と inspection skeleton に対応し、コード変更以外の定型作業・自動テストにも
  Garelier を使いやすくしました。
- Public export scanning now ignores test fixture false positives for concrete
  `__garelier/...` paths and test-only email addresses while keeping the shipped
  publish set gate strict. / public export scan は test fixture 内の concrete
  `__garelier/...` path と test-only email の false positive を除外しつつ、公開対象
  tree への gate は維持します。

## [2.8.3] - 2026-06-25

Dock-lane comfort release (DEC-083): the mechanical merge tail moves OUT of the
LLM workflow into deterministic TS (dock_integrate.ts), root-fixing the recurring
StructuredOutput-drop; one-shot status (dock_status.ts, JSON-default for agents)
supersedes + retires status.ps1/status.sh. Builds on the jig durability release
(DEC-082). / ドックレーン快適化リリース(DEC-083): 機械的マージ末尾を LLM workflow
から決定論的 TS(dock_integrate.ts)へ出し、再発する StructuredOutput drop を根治。
一発 status(dock_status.ts、agent 用 JSON 既定)が status.ps1/status.sh を置換・retire。

### Added (DEC-083)

- `dock_integrate.ts` — deterministic ZERO-LLM merge tail (merge_request -> await
  terminal -> dispatch_event -> cleanup-on-success), per-item serial (single-poller),
  idempotent (adopt an in-flight request keyed on `workbench_branch` VERBATIM, not
  the lossy SAFE_TASK; re-detect an already-merged tip before re-merging on aborted;
  gate_held dispatchId==null -> cleanup no-op). DI core (`integrateItems`) unit-tested
  (10 tests) + production-validated (recovered a real mergeUntracked end-to-end:
  adopt+await+record+cleanup). `--items` / `--items-b64`. / 決定論的ゼロLLM マージ末尾。
- `dock_status.ts` — one-shot aggregated status (thin buildSnapshot/buildOverview
  projection + derived driver-liveness block), `--format json` default (agent
  one-shot) / `--format text` (human), broken-config -> ok:false exit 0. / 一発集約 status。

### Changed (DEC-083)

- jig_tick.workflow.js split: pipeline 4 stages -> 2 (dispatch/gate); the
  schema-bearing INTEGRATE merge-await agent (the recurring StructuredOutput-drop
  source) + the RECORD agent are DELETED. ONE thin journaled agent runs
  dock_integrate.ts over all GATED branches (items handed via a quoted-heredoc
  file — no btoa/runtime-global dependency). The GATE warm-rework loop stays.
  A dropped agent summary loses NOTHING (dock_integrate already recorded+cleaned;
  surfaces as integrateUntracked, safer than the old MERGE_UNTRACKED). /
  jig_tick 分割: マージ末尾を thin journaled agent 経由 dock_integrate へ。drop しても損失ゼロ。
- status.ps1 + status.sh RETIRED -> dock_status.ts; `garelier status` (both shells)
  + session_digest hints + docs redirected; Status Web + doctor unaffected (they use
  buildSnapshot / comments-only). / status.ps1/sh を retire、`garelier status` を redirect。

Jig durability release (DEC-082): the dispatch tick no longer loses work to a
producer that dies mid-task, no longer cold-restarts rework, no longer reports a
merge as done before it is, and no longer stalls silently on an idle peer. /
ジグ耐久性リリース(DEC-082): ディスパッチ tick は、途中で死んだプロデューサの作業を
失わず、リワークを cold 再実装せず、マージ完了前に「完了」と報告せず、アイドルな
ピアで静かに停止しない。

### Added

- Merge-await (DEC-082 fix-1): `dock_merge.ts await --request-id <id>` blocks
  until the merge gate writes a TERMINAL result (`success|failed|conflict|
  aborted`), re-running the idempotent poll advancer each iteration and bounded
  by `--ceiling-ms` (exits with `status:"timeout"` rather than hanging; a dead
  gate pid self-heals into a synthetic `aborted`). Both `jig_tick` and
  `jig_gate_held` INTEGRATE now call it, so a tick completes only when the merge
  is DONE — not merely enqueued. / マージ待機(DEC-082 fix-1): `dock_merge.ts
  await` がマージゲートの**終端**結果まで block。`jig_tick`・`jig_gate_held` の
  INTEGRATE が呼び、tick 完了＝マージ完了(enqueue ではなく)。
- `AGENT_DIED` outcome + `agentDied` bucket (DEC-082 fix-4): a producer that
  dies mid-task (quota/crash → falsy result) is now a distinct, RETRYABLE
  outcome that keeps `{dispatchId, branch}` so the work committed on its warm
  worktree survives, surfaced with a warm-resume retry hint instead of being
  silently folded into `FAILED`/`blockedOrParked`. / `AGENT_DIED` 結果＋
  `agentDied` バケット(fix-4): 途中で死んだプロデューサを別個の**再試行可能**結果
  として扱い、warm worktree 上の作業を温存。
- `MERGE_UNTRACKED` outcome + `mergeUntracked` bucket (DEC-082 fix-5): the
  INTEGRATE merge-await agent is wrapped in try/catch, so when it runs
  `merge_request.sh` (spawning the gate) but fails to emit StructuredOutput — an
  LLM that treats the bash output as its answer and skips the final tool call,
  observed in production — the thrown `agent()` no longer DROPS the whole pipeline
  item while the merge silently proceeds. The item surfaces as `MERGE_UNTRACKED`
  with a recover hint (`dock_merge status -> await -> cleanup`); the agent prompt
  is also tightened to demand the StructuredOutput call. / `MERGE_UNTRACKED`(fix-5):
  INTEGRATE を try/catch で包み、merge_request 実行後に StructuredOutput を出さず
  落ちても item を消さず `mergeUntracked` に surface(マージ自体は進行、out-of-band 確認)。

### Changed

- Warm rework loop (DEC-082 fix-2): on `NEEDS_REWORK`/`REFUTED` the GATE stage
  now RESUMES the producer's OWN warm worktree (`produce({kind:'rework',
  findings})`, incremental build) up to `max_rework_rounds`, re-gating each
  round, before escalating — eliminating the cold re-implement a PM re-dispatch
  caused. The resume prompt verifies the checkout still exists (BLOCKED if
  cleaned up, never fabricates work); falls back to escalation when there is no
  warm worktree. / ウォームリワークループ(fix-2): リワーク時にプロデューサ自身の
  warm worktree を resume(incremental build)し再ゲート。cold 再実装を解消。
- Wanderer idle-resilience (DEC-082 fix-3): `wanderer_drive` re-sends the
  file-pointer prompt (≤3×, on 20s no-progress windows) to wake a pane that
  dropped the first nudge; `wanderer_hook` re-surfaces a still-pending request
  every turn. Both bounded and best-effort — the PM await-timeout + automatic
  Observer fallback remains the reliability floor (DEC-076 §4). / Wanderer
  アイドル耐性(fix-3): `wanderer_drive` がプロンプト再送(≤3回)、`wanderer_hook`
  が未応答リクエストを毎ターン再提示。信頼性の下限は従来どおり PM await タイムアウト
  ＋ Observer 自動フォールバック。

## [2.8.2] - 2026-06-23

Context-efficiency release: deterministic "briefs" that move the routine, raw
reading out of the model context (registries / diffs / reports / project facts)
while the agent keeps every verdict and can always read the raw material. /
コンテキスト効率リリース: ルーチンな丸読み(レジストリ・diff・レポート・プロジェクト
事実)をモデル文脈の外へ出す決定論的「ブリーフ」群。verdict は常にエージェントが保持し、
生データもいつでも読める。

### Added

- Generalized context-pack (DEC-081): a dispatch **fact-pack** (`context.json`
  forward-supplies the gate command / target_slug / branch names / base sha /
  blueprint anchors every producer re-derived in its cold worktree), a pickup
  **diff-brief** (`review_brief` — diffstat + per-file flags + diff-vs-report
  mismatch + parsed gate + claims for Observer / Smith / Guardian), and a **Dock
  pulse** (`dock_pulse` — role-status vector + report.json claims + triage
  signals). Measured input reduction: 70–96% for the fact-pack and diff-brief on
  real data. / 汎用 context-pack(DEC-081): dispatch **fact-pack**(`context.json`
  がゲートコマンド/target_slug/ブランチ名/base sha/blueprint アンカーを前方供給)、
  初動 **diff-brief**(`review_brief`)、**Dock pulse**(`dock_pulse`)。実測 70–96%
  の入力削減(fact-pack・diff-brief)。
- Guardian scan draft-producer (DEC-079): `guardian_scan` applies the Librarian
  `security/` registries (secret / PII / injection) in Bun and emits a **redacted,
  pointer-only** draft + provisional verdict; the agent keeps final authority,
  fail-closed on secrets. / Guardian スキャン草案生成(DEC-079): `guardian_scan` が
  `security/` レジストリを適用し、**redact 済み pointer-only** 草案＋暫定 verdict を出力。
  最終権威はエージェント、秘密は fail-closed。

### Changed

- Observer / Smith / Guardian / Dock pickup flows read a compact brief first, then
  open only what they need; the brief is advisory and additive — the agent never
  loses the full read. / Observer/Smith/Guardian/Dock の初動は compact brief を先に
  読み、必要箇所だけ展開。brief は助言・加算的で、生読みは常に可能。

### Fixed

- **`guardian_scan` recall (security-critical)**: the security registries are
  authored in PCRE/RE2 syntax with leading `(?i)` inline flags, which JS RegExp
  rejected — `guardian_scan` silently skipped 9 of 21 patterns (injection
  detection was 100% non-functional). It now translates the inline flags, surfaces
  any un-compilable pattern in `skipped_patterns`, marks the dimension
  `coverage: "degraded"`, and downgrades a degraded mandatory scan to `NO_OPINION`
  so it can never clean-PASS. / **`guardian_scan` の recall(セキュリティ重大)**:
  レジストリの先頭 `(?i)` を JS RegExp が拒否し 21中9パターンを黙ってスキップ
  (インジェクション検出が 100% 不全)。インラインフラグを翻訳し、未コンパイルを
  `skipped_patterns`/`degraded` で明示、degraded な必須スキャンは `NO_OPINION` に降格。
- `dock_pulse` resolves exiled role containers (DEC-036) via the `workspace_paths`
  pointer, so a relocated role is never omitted from the digest. / `dock_pulse` が
  exile されたコンテナを `workspace_paths` 経由で解決。
- Briefs / drafts write to the gitignored container / `runtime/`, never the
  checkout worktree (a brief must not be staged by a commit-bearing role). /
  brief/draft は gitignore 済みのコンテナ/`runtime/` へ書き出し、checkout worktree
  を汚さない。
- `context_pack` CLI aligned to `--project`; `wanderer_hook` subprocess tests get
  a generous timeout (flake fix). / `context_pack` の CLI を `--project` に統一、
  `wanderer_hook` のサブプロセステストにタイムアウト付与(flake 修正)。

## [2.8.1] - 2026-06-21

Patch release: the Wanderer liveness handshake (DEC-078), dispatch / quality-gate
tooling, and ignore / CI hygiene fixes. / パッチリリース: 放浪者の生存確認
ハンドシェイク(DEC-078)、ディスパッチ・品質ゲート系ツール、ignore・CI 整備。

### Added

- Wanderer liveness handshake (DEC-078): the Wanderer emits `ack` / `progress`
  signals and the PM review gate extends its wait while the Wanderer proves it is
  alive — a slow-but-working review is no longer abandoned to the Observer at a
  flat timeout; `--legacy` restores the old behaviour. / 放浪者の生存確認
  ハンドシェイク(DEC-078): 放浪者が `ack` / `progress` を発し、PM のレビュー
  ゲートは生存が示される限り待機を延長 — 遅いが稼働中のレビューを固定タイム
  アウトでオブザーバーに切り替えなくなった。`--legacy` で旧挙動に復帰。
- Concrete Claude Code Wanderer setup (presence hook + Monitor tool) alongside the
  Codex path, plus a live-pane review gate (nudge + read / peer-cli auto-approve +
  pane-alive liveness, DEC-076 §6). / Codex 経路に加え Claude Code 放浪者の具体
  セットアップ(presence フック + Monitor)と、ライブペインのレビューゲート
  (nudge + read / peer-cli 自動承認 + pane 生存確認、DEC-076 §6)。
- Optional `[quality_gate] run_verify_commands` — a post-merge RUNTIME gate that
  runs an actual smoke / verify after integration. / 任意の `[quality_gate]
  run_verify_commands` — 統合後に実 smoke / verify を走らせる post-merge RUNTIME
  ゲート。
- `jig_render.{sh,ps1}` — one-command tick render for a manual one-off dispatch
  (DEC-062). / `jig_render.{sh,ps1}` — 手動一発ディスパッチ用のワンコマンド tick
  レンダー(DEC-062)。
- PM commit guard (pre-commit) blocking misplaced and mid-merge commits (DEC-075
  follow-up). / 誤配置・マージ中コミットを防ぐ PM コミットガード(pre-commit、
  DEC-075 フォローアップ)。

### Changed

- AGENTS template: runtime-effect changes now call for an actual-RUN verification,
  not just compile + unit tests. / AGENTS テンプレート: ランタイム効果を伴う変更は
  compile + 単体テストだけでなく実 RUN 検証を要求。

### Fixed

- `dispatch_cleanup` refuses to run while a merge is in flight. / マージ実行中は
  `dispatch_cleanup` を拒否。
- gitignore / ignore now cover the `_dispatch<N>/` ephemeral producer homes and
  reserve `_wanderers/`; `search_ignore` gains the missing `_concierges/`. /
  gitignore・ignore が一時プロデューサーホーム `_dispatch<N>/` を網羅し
  `_wanderers/` を予約。`search_ignore` に欠けていた `_concierges/` を追加。
- Restored the executable bit on `install_pm_commit_guard.sh` and `jig_render.sh`;
  the AGENTS template smoke example no longer uses the `{{}}` substitution marker
  (which tripped the doctor placeholder-leak gate). / `install_pm_commit_guard.sh`・
  `jig_render.sh` の実行ビットを復元。AGENTS テンプレートの smoke 例が置換マーカー
  `{{}}` を使わないよう修正(doctor のプレースホルダ検出に抵触していた)。

## [2.8.0] - 2026-06-20

Minor release introducing two-layer knowledge storage (shared `__atmos` +
per-pm) and the operational/UI consistency work around it. / 二層知識ストレージ
(共有 `__atmos` + per-pm)と、その運用・UI 整合を導入する minor release。

### Added

- Two-layer knowledge storage (DEC-077): Garelier knowledge moves off
  `docs/garelier/` into a shared, project-wide `__garelier/__atmos/knowledge/`
  tier plus an additive per-pm `__garelier/<pm_id>/knowledge/` layer (both
  tracked, both reach `<target>` via promote). Resolution is shared-priority +
  per-pm-additive, with an explicit, auditable per-topic `override_shared: true`
  opt-in; the graph validator warns `shadowed-by-shared`. The per-pm layer is the
  seeded working home; the shared `__atmos` tier is created on demand. / 二層知識
  ストレージ(DEC-077): 知識を `docs/garelier/` から、共有・プロジェクト全体の
  `__garelier/__atmos/knowledge/` 層と、加算的な per-pm
  `__garelier/<pm_id>/knowledge/` 層へ移行(両層とも tracked、promote で
  `<target>` に到達)。解決は共有優先 + per-pm 加算で、明示的・監査可能なトピック
  単位 `override_shared: true` オプトインを持つ。グラフバリデータは
  `shadowed-by-shared` を警告。per-pm 層がセットアップ時に seed される作業 home、
  共有 `__atmos` 層はオンデマンド作成。
- Standalone `garelier-control-library` promotion gate substituting for Dock
  review (source / rights / changed knowledge_id / meaning-change / target-layer
  / approval / graph validation). / Dock レビューの代替となる standalone
  `garelier-control-library` の promotion gate を追加。

### Changed

- The Status Web Knowledge page and the derived knowledge graph are
  override-aware and union `role_index.toml` across both layers; documents show a
  shared / pm / override layer marker. / Status Web の Knowledge ページと派生
  知識グラフを override 対応にし、`role_index.toml` を両層で union。ドキュメントに
  層マーカー(shared / pm / override)を表示。
- The promote checklist, PM promote flow, and the protocol "Tracked in Git?"
  table now account for both knowledge layers riding a promote. / promote
  checklist・PM promote フロー・protocol の "Tracked in Git?" 表が、promote に
  乗る両知識層を考慮。
- README restructured: a simpler hero diagram on top, the detailed system
  overview moved into "more details", and a dedicated Status Web section. /
  README を再構成: 冒頭に簡潔な概要図、詳細なシステム図を「もっと詳しく」へ移動、
  Status Web セクションを新設。

### Fixed

- `docs/garelier` legacy support fully removed and knowledge references made
  layer-agnostic; registry references carrying a knowledge-root prefix resolve
  correctly. / `docs/garelier` の legacy サポートを完全撤去し、知識参照を層
  非依存化。知識ルート接頭辞付きの registry 参照を正しく解決。
- Inverted two-layer precedence wording in the `role_index.toml` template,
  `doctor.{sh,ps1}` comments, and the knowledge docs corrected to shared-first
  with the `override_shared` exception. / `role_index.toml` テンプレート・
  `doctor.{sh,ps1}` コメント・知識ドキュメントの二層優先順位の逆転記述を、
  `override_shared` 例外付きの共有優先へ修正。
- `init_control` substitutes the `{{pm_id}}` placeholder in `control.toml`. /
  `init_control` が `control.toml` の `{{pm_id}}` プレースホルダを置換。

## [2.7.3] - 2026-06-20

Patch release for release-readiness, plugin metadata hygiene, and setup/control
migration robustness. / リリース準備、plugin metadata 整理、setup/control 移行の
堅牢化のための patch release。

### Fixed

- Per-PM `setup_wizard --mode migrate` now bumps any prior
  `garelier_version` / `wizard_version` to the installed version even when the
  project was already in the per-PM layout and only worktree relocation runs. /
  per-PM 済み layout で worktree relocation だけが走る `setup_wizard --mode
  migrate` でも、任意の旧 `garelier_version` / `wizard_version` を installed
  version へ更新するよう修正。
- `consolidate_controls.sh` no longer aborts under `set -u` when a
  consolidation has zero conflicting files. / conflict 0 件の control
  consolidation で `set -u` により `consolidate_controls.sh` が停止しないよう修正。

### Changed

- Internal Garelier role/reference skills now declare `user-invocable: false`,
  leaving only `garelier-pm`, `garelier-control-project`, and
  `garelier-control-library` visible as user entry points. / 内部 role/reference
  skill に `user-invocable: false` を付与し、ユーザ entry point として見えるのを
  `garelier-pm` / `garelier-control-project` /
  `garelier-control-library` のみに整理。
- Distributed shell scripts now keep the tracked executable bit, and CI enforces
  it for `.sh` files and `bin/garelier`. / 配布対象 shell script の git
  executable bit を保持し、CI が `.sh` と `bin/garelier` の実行 bit を検査。
- Artisan and Librarian entrypoints were slimmed by moving long lifecycle/scope
  detail into reference files, preserving behavior while reducing slash-menu and
  skill-entry noise. / Artisan と Librarian の長い lifecycle / scope 詳細を
  reference file に移し、挙動を保ったまま entrypoint を薄く整理。

### Documentation

- Documented the Wanderer advisory-review role in AGENTS, concepts, and pipeline
  flow docs, including the DEC-076 peer-channel fallback to Observer. / Wanderer
  advisory-review role を AGENTS / concepts / pipeline flow docs に反映し、
  DEC-076 の peer-channel と Observer fallback を明記。
- Added setup upgrade guidance for in-place migrate from older Garelier versions.
  / 旧 Garelier からの in-place migrate による setup upgrade 手順を追加。

## [2.7.2] - 2026-06-19

Documentation, packaging cleanup, and a PM conversation-tone fix. /
ドキュメント整備・不要設定の撤去・PM の会話トーン修正。

### Changed

- Removed the inert `[execution]` backend config axis — dead residue of the
  headless driver deleted in DEC-066; nothing read it, and Codex routing is
  per-role. / 誰も読んでいなかった `[execution]` backend 設定軸を撤去(削除済み
  headless driver(DEC-066)の残骸。Codex への振り分けはロール単位)。
- Setup wizards no longer emit driver-era prose (mode `b`, per-poll concurrency,
  "driver iterations"); the generated config matches the dispatch model. /
  setup wizard が生成する config から driver 時代の記述(mode `b`・毎ポーリング
  の並列数・"driver iterations")を除去し、dispatch モデルに一致。

### Fixed

- PM no longer drifts into casual or rough Japanese after the skill loads;
  register is now surface-aware — conversational prose stays polite (ですます調),
  reports and bullets stay terse, and crude forms are avoided throughout. /
  garelier-pm 有効化後に日本語の口調が荒れる問題を修正。語調を面ごとに規定
  (会話=ですます調、報告・箇条書き=端的、乱暴な語尾は常に回避)。

### Documentation

- Rewrote the README around the user journey (what → install → use → remove →
  learn more) and made it bilingual in one file (Japanese + English). /
  README を利用者動線(これは何→導入→使い方→取り外し→詳細)で再構成し、
  1 ファイル日英併記に。
- Added Japanese `.ja` companions for the control contract, knowledge contract,
  and execution-backends docs; translated the compact-handoff and output-control
  summaries to Japanese. / control / knowledge / execution-backends の各 docs に
  日本語版 `.ja` を追加し、compact_handoff・output_control を日本語化。
- Codified the bilingual policy (English canonical `X.md` + Japanese `X.ja.md`
  companion); the changelog is bilingual from this release onward. /
  バイリンガル方針(英語正本 `X.md` ＋日本語 `X.ja.md`)を明文化。CHANGELOG は
  本リリースから日英併記。

## [2.7.1] - 2026-06-19

Patch release for the DEC-076 Wanderer review path and control-schema
consistency.

### Fixed

- **Wanderer review fallback** (DEC-076): a launched Wanderer that is
  rate-limited, quota-exhausted, returns 429, or is otherwise unavailable now
  yields `fallback_observer` so the PM switches to the Observer subagent instead
  of waiting on an unusable peer.
- **Wanderer singleton handling** (DEC-076): the PM-side launcher no longer
  opens another Wanderer while a recorded pane is still alive. A live but stale
  pane requires manual inspection, hook trust, nudge, or close before another
  launch.
- **Wanderer hook harvest contract** (DEC-076): intermediate acknowledgements no
  longer clear a pending review request. The hook relays only canonical
  verdict-bearing replies or explicit unavailable notices.
- **Control schema normalization**: current control-dashboard artifacts now
  validate cleanly against the control graph after the schema tightening in
  v2.7.0.
- **Public export private-identifier scan**: the public-export guard no longer
  misses private identifiers that appear inside path-like or punctuation-adjacent
  strings.

## [2.7.0] - 2026-06-18

Headline: the **Wanderer** — an opt-in, read-only external advisory peer (a
separate Claude Code / Codex CLI session on a strong model) that independently
reviews non-trivial PM design work over a tool-agnostic, file-based peer-channel
and reaches mutual sign-off before a blueprint is finalized; falls back to the
Observer subagent when absent (DEC-076). Plus subagent-dispatch reliability
hardening (DEC-073), Monitor-stall recovery (DEC-074), and merge-gate / Dock
commit serialization (DEC-075), surfaced by live driving on a RAM-bound Windows
host. Independent community project; not affiliated with Anthropic or OpenAI.

### Added

- **Wanderer — external advisory peer review** (DEC-076): a new `garelier-wanderer`
  role plus a tool-agnostic, file-based **peer-channel** (TypeScript core + CLI). The
  Wanderer is a separately-launched Claude Code / Codex CLI session (NOT a subagent)
  on a strong model that independently reviews non-trivial PM design work
  (blueprints / design specs) and reaches mutual sign-off before finalization. It is
  delivered via a Stop-hook verdict harvest (not the project `AGENTS.md`), auto-wired
  into PM blueprint authoring for the configured triggers (large diff / new top-level
  key / protected path / architecture / policy change), and falls back to the Observer
  subagent when the peer is absent or silent past the timeout. Opt-in; driven by the
  peer-channel launcher / review CLI plus a Stop-hook adapter (the shipped
  `garelier-wanderer` skill includes a Codex setup guide, a PM-side launcher,
  Windows/Codex operational notes, and a minimal-token file-pointer drive).
- **Worker-requested Observer direction advice** in the jig tick: a worker can request
  non-binding implementation-direction advice from the Observer within assignment scope
  during `ga-tick`.
- **Merge-gate quality-gate passthrough**: `merge_request.sh` now writes
  `quality_gate_commands` from a `--quality-gate` flag / the `[quality_gate]
  merge_gate_commands` config, so the merge gate runs the configured gate on the merge
  result.
- **Merge-gate ↔ Dock commit serialization** (DEC-075): the Dock
  must NOT `git commit` on the `studio` primary checkout while a merge gate is
  active — the async gate stages its merge in the same checkout (`MERGE_HEAD`), so
  an interleaved commit hijacks the staged merge into a mislabeled merge commit and
  bypasses the gate's verdict (observed live). The rule: before any Dock
  `studio` commit, verify both `runtime/merge_gate/locks/active.lock` and
  `.git/MERGE_HEAD` are absent; otherwise wait for the gate. Documented in
  `references/role_subagent_dispatch.md` §3.

- **Monitor-stall recovery via Agent Teams SendMessage** (DEC-074): when a
  dispatched producer ends its turn mid-gate against the run-to-completion rule
  (DEC-073 Part A guidance is ~57% effective on its own), the Dock
  recovers it WITHOUT losing context by resuming the stopped subagent via
  `SendMessage` (available when Claude Code Agent Teams is enabled,
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) so it finishes its OWN gate — the
  Worker↔Dock gate-ownership contract is preserved (no re-draw). Documented in
  `references/role_subagent_dispatch.md` §3 with the Dock-finishes-it-self
  fallback for when Agent Teams is off. The alternative "Dock owns the full gate"
  re-draw was considered and declined.
- **Cross-layer heavy-compile lock** (DEC-073 Part B): new `bun`-run helper
  `skills/garelier-core/scripts/heavy_compile_lock.ts` serializes heavy build
  initiators (the merge gate, the driver/jig, an interactive Dock) so a
  worker's `cargo build --workspace` no longer runs in parallel with the async
  merge gate's `cargo test --workspace --no-run` and OOMs / corrupts target
  dirs. Configured via a new `[heavy_compile]` block in `setup_config.toml`
  (default serialize-1; opt out when builds are concurrency-safe). The merge
  gate now wraps its quality gate with the lock. The lock fail-opens on timeout
  and self-heals (owner-pid-dead + lease reclaim), so it can never deadlock.

### Changed

- **Terminology: `orchestrator` → `Dock`** across active dispatch references and
  the remaining documentation, plus a `ga-*` workflow display-string naming
  convention, for one consistent name for the dispatcher/integrator role.
- **Producer run-to-completion is now explicit** (DEC-073 Part A): a producer
  must run gate/build/test commands in the foreground and never offload a
  blocking command to a `Monitor`/background task then end its turn (there is no
  re-wake — it strands the task and orphans the build). Stated in
  `correct_operation.md` (new item 12), the `role_subagent_dispatch.md` prompt
  template + constraints, and the Worker SKILL boundaries.

### Fixed

- **Robust, self-healing worktree cleanup** (DEC-073 Part C): on Windows a
  lingering rustc/sccache/cargo handle under `target/` could block
  `dispatch_cleanup` from deleting the worktree dir — the `.ps1` exited 1
  (crashing the caller) and the `.sh` failed under `set -e`, leaking stale
  `_dispatch<N>/` dirs. Cleanup now retries with backoff, defers a still-locked
  dir to `runtime/backlog/failed_cleanups.jsonl` and exits 0 (git is already
  pruned), and a new `--sweep` mode (called best-effort by `dispatch_prepare` on
  every new dispatch) converges stale dirs once their handle releases.

## [2.6.5] - 2026-06-13

Plugin metadata correctness patch for the v2.6.4 public package.

### Fixed

- Role-skill descriptions now use valid folded YAML scalars so Claude Code
  preserves activation metadata instead of silently dropping it.
- CI now parses every shipped `SKILL.md` frontmatter block with Bun's YAML
  parser, preventing malformed plugin metadata from reaching another release.

## [2.6.4] - 2026-06-13

Planning, dispatch, and knowledge-quality refinements developed after the
public-package readiness pass. This release also establishes TypeScript as the
default implementation language for post-setup cross-platform helpers.

### Added

- **External-pattern intake and context-pack feedback** (DEC-067 / DEC-071):
  constitution triggers, design-options and retro-digest artifacts, explicit
  context-pack gap reporting, and parking when an assignment lacks required
  context.
- **Risk-first planning guardrails** (DEC-070): milestones identify the
  riskiest unknown first, blueprints link work to the risk they retire, and
  control views surface planning drift.
- **Jig Smith windows** (DEC-069): deterministic accumulated-merge hardening
  controlled by `smith_batch_every`.
- **Engineering knowledge** for debugging first moves, change propagation, and
  phased large-scale refactoring.

### Changed

- **TS-first helper policy** (DEC-072): new post-setup helpers are single
  TypeScript files run by Bun. `retro_digest.{sh,ps1}` was migrated to
  `retro_digest.ts` as the output-compatible pilot.
- **Setup UX** (DEC-068) now scans first, proposes the `AGENTS.md` fill,
  explains permission choices, and closes the first-goal workflow.
- **Jig records** retain block reasons for later resume and retrospective
  analysis.

### Fixed

- Doctor now reports missing Jig Smith knowledge views and dangling role-index
  references instead of silently skipping those dependency failures.
- Installation prerequisites are copy-runnable for Bun, gitleaks, and
  PowerShell, and stale driver wording was removed from getting-started
  guidance.
- Release planning state was reconciled with already-published v2.5/v2.6 tags,
  and the control runbook now describes dispatch-only operation.

## [2.6.3] - 2026-06-12

Public-package readiness pass, triggered by an external review of the GitHub
repo. Most of the review's P0 claims (invalid manifest JSON, collapsed SKILL
frontmatter, vanishing placeholders) did not reproduce — both manifests parse,
all 13 skill frontmatters are well-formed, and placeholders sit inside code
spans — but the sweep surfaced real items, fixed here.

### Fixed

- **Install steps are copy-runnable**: `getting_started` clone commands name
  the real repository URL and the dev-mode `CLAUDE_PLUGIN_ROOT` export uses
  `"$(pwd)"` / `(Get-Location).Path` instead of a fill-in placeholder.
- **`canonical_index.md`**: the rows pointing into `__garelier/<pm_id>/…`
  are now explicitly marked internal dogfooding state NOT shipped in the
  public package, and a stale claim about a deleted driver-era CI test
  (`git_allowlist_coverage`) was corrected.
- **Protocol top-level-control sentence** (EN+JA) no longer reads as if
  `__garelier/<pm_id>/control/` itself didn't exist — it says there is no
  *shared* top-level `__garelier/control/`.
- Two multi-line inline-code spans reflowed so angle-bracket placeholders
  can never be mistaken for HTML tags in any renderer.

### Changed

- **Marketplace-facing metadata softened to the supervised framing**:
  plugin/marketplace descriptions now say "human-supervised … local project
  coordination … review gates" (dropping "long-running large-scale
  development"); the `autonomous` keyword was replaced; the README lead
  says 長期プロジェクトの開発状態を整理して継続的に進めやすくする under
  human supervision; `execution_backends` describes the Dock
  session as user-attended.
- **Jig preflight now runs doctor**: P0 findings PARK the whole tick —
  nothing dispatches onto a broken install (the README's "no automatic
  doctor pre-check yet" roadmap note is hereby obsolete and updated).

## [2.6.2] - 2026-06-12

Operability refinements distilled from running full dispatch cycles as the
operator (the marketplace submission build).

### Added

- **Gate-held resume template**
  (`templates/jig_gate_held.workflow.js`): when a producer finishes its work
  but returns BLOCKED, its branch survives the tick; after the block is
  resolved, this template runs the same Guardian → adversarial refuter →
  Observer → merge gate → record order WITHOUT re-running the producer
  (`args.note` carries the dispositioned context so reviewers do not
  re-block on it). Proven live before templating.
- **Report scaffold** (`dispatch_prepare.{sh,ps1}`): every dispatch container
  starts with a pre-created `report.md` skeleton, making the report location
  structural; `dispatch_cleanup.{sh,ps1}` now archives the container's
  report/questions/answers to `runtime/backlog/done/<id>-<slug>.md` before
  removal (the protocol's completed-work archive, mechanized).
- **Base-health preflight + pre-existing-failure protocol**
  (`templates/jig_tick.workflow.js`): a cheap read-only check warns when the
  studio tip is not the newest successful gate merge, and producers carry an
  explicit rule — a gate failure that reproduces at the base SHA is
  PRE-EXISTING: report BLOCKED with evidence, never widen scope. Stops
  parallel producers from independently re-diagnosing the same broken base.
- **Dispatch worktree build-cache knowledge**
  (`garelier-librarian/templates/engineering/dispatch_worktree_build_cache.md`):
  on compiled stacks the cold per-worktree rebuild dominates producer
  wall-time; share a compilation cache project-locally (with trust-boundary
  and staleness caveats). Indexed in the engineering knowledge tree.

## [2.6.1] - 2026-06-12

Public-surface consistency patch on top of 2.6.0 — every operator-visible
surface now tells the dispatch-only story, ahead of the community-marketplace
submission.

### Fixed

- **`garelier` CLI shim**: the `driver` / `stop-driver` subcommands routed to
  scripts deleted by DEC-066; removed, and the dispatch helpers
  (`dispatch-prepare` / `dispatch-cleanup` / `dispatch-event` /
  `merge-request`) joined the single front door (bash + PowerShell).
- **Wizard-generated `_pm/.claude/settings.json`**: dropped the SessionEnd
  hook that touched `runtime/driver/stop` — nothing reads a stop file under
  dispatch-only. SessionStart digest unchanged.
- **`templates/setup_config.toml`**: the canonical config documentation shed
  its driver-era claims — `[runner]` documents seat-default dispatch routing
  (DEC-063/058), `[autonomy]` documents the goal-driven `/loop` + jig tick
  (no `mode`/`driver_poll_interval_seconds`/`supervise_pm`), `[execution]` is
  marked inert, `[concurrency]` is reframed as Dock dispatch-ordering
  guidance, and a deleted provider-smoke path reference was removed.
- **Plugin manifests**: version was still 2.5.0; bumped and enriched with
  `displayName` / `homepage` / `repository` / author URL per the plugin
  schema. Install instructions name the real public repo.
- README screenshots retaken from the live dispatch-native Status Web; the
  prototype/draft/skeleton status banners and the word 無人 dropped
  (autonomy is framed as goal-driven `/loop` self-pacing); a broken relative
  link in `driver/src/dispatch/README.md` fixed; the Librarian rename-runbook
  template and the wizard parity checklist updated to dispatch-only
  procedures.

## [2.6.0] - 2026-06-12

Dispatch-only consolidation: the headless driver is **removed outright**, the
deterministic Jig tick becomes the default loop mechanism, and every state
surface (CLI, Status Web, docs, doctor, wizard) reports only what is real
under dispatch. Validated end-to-end on a live Rust/Bevy target project.

### Removed

- **Driver-era code deleted outright (DEC-066; supersedes the DEC-061
  "disabled" posture).** The headless per-iteration driver (`main.ts`,
  `agent_child.ts`, `role.ts`, `prompts.ts`, the provider adapters,
  `start_driver` / `stop_driver` scripts) and its UI/CLI surfaces (pid/lease
  panels, per-slot context usage, efficiency page, role-capacity tables,
  rate-limit warnings) are gone. Operator principle adopted: a surface the
  user can see must never report fiction.

### Added

- **Jig — Mode E deterministic tick (DEC-062), default-ON.** One tick =
  DISPATCH → GATE (Guardian → Observer) → INTEGRATE → RECORD, run as a
  Workflow *script* (`templates/jig_tick.workflow.js`): order is enforced by
  code; the model judges only content. `[jig]` config (fan_out_cap,
  max_rework_rounds, review depth by criticality); `enabled` defaults true —
  absence of the key arms the jig, `false` opts out to the prose tick.
- **Dispatch scaffolding (DEC-063).** `dispatch_prepare.{sh,ps1}` (atomic id
  claim + worktree off the studio tip + STATE.md + start event),
  `dispatch_cleanup.{sh,ps1}` (dual layout, Windows long-path fallback),
  `entry_routing.md` (single front door: control-only vs artisan vs dock) and
  `model_routing.md` (model tier by judgment density, tuned for mid-tier
  Docks).
- **Protocol diet (DEC-064).** `merge_request.{sh,ps1}` builds a complete
  merge request (derived studio branch, non-empty message, verdict flags) in
  one command and runs the zero-LLM gate poll; a combined-reviewer profile
  lets one agent emit both verdicts on normal-risk merges. Diet criterion:
  anything the Dock must *remember* (rather than decide) is a defect.
- **Single-source runtime execution state (DEC-064 §3, W-011).**
  `runtime/dispatch/events.jsonl` is the append-only record;
  `dispatch_event.{sh,ps1}` appends events AND regenerates
  `backlog/in_flight.md` as a GENERATED view of the live `_dispatch<N>`
  containers; manifests carry no per-agent roster tables; the Status Web
  derives the Live work board from the containers (structural truth).

### Changed

- **Dispatch-native fresh layout (DEC-065, W-012).** Fresh setup creates only
  `_pm/`, `control/`, `runtime/` — no `_dock/`, no role worktrees. Roster
  entries in `setup_config.toml` are seat defaults (provider/model routing);
  a persistent role container is created on demand only (wizard diff mode).
  Doctor treats a missing container as healthy; a half-created one stays P1.
- **Status Web modernized.** Seven consolidated views (Dashboard / Work /
  Knowledge / Control / Files / Flow / Guide), refreshed visual system, and a
  dispatch-aware dashboard: live ephemeral producers, parked-inventory
  framing for legacy containers, capacity measured against the jig
  fan-out cap.
- **`status.{sh,ps1}` rewritten dispatch-native** (lane / merge gate /
  backlog / LIVE `_dispatch<N>` / parked inventory / recent events), and
  `session_digest.{sh,ps1}` report merge-gate + live-dispatch state instead
  of driver pids/leases.
- License/commercial documentation corrected (NOTICE dependency list, elkjs
  claim, MPL-2.0 policy/registry contradiction) and skill documents hardened
  for mid-tier-model robustness
  (`mid_tier_model_robustness.md`: code enforces order; the model judges
  content).

## [2.5.0] - 2026-06-09

This release is developed in two waves: a **spec** wave (role docs, DECs,
templates, config schema — version-stamped 2.5.0) and an **implementation**
wave (driver wiring, setup-wizard generation, doctor, CI). Entries below note
which wave each item belongs to where it is not yet fully wired.

### Changed

- **Document-format standardization + non-mandatory enforcement (DEC-051).**
  A canonical commit-message convention (Conventional Commits + bound item ID;
  `skills/garelier-core/commit_convention.md`) and a fixed-schema PM history
  entry (`skills/garelier-pm/templates/history_entry.md`, with a reason-code enum
  and bounded Notes) remove per-AI/session variance and token bloat. Enforcement
  stays a removable layer: Garelier-produced commits are validated in-pipeline
  and humans may opt into a local git hook; it is **never** a repo-global git
  hook or a shared-CI gate in a target project, so non-Garelier / other-skill
  contributors and plain `git`/build/test are unaffected.
  - **Nested ignore files (DEC-051; root untouched).** Setup and the
    control-only init scripts now write a nested `__garelier/.gitignore` (from
    `runtime_gitignore`, patterns relative to `__garelier/`) and
    `__garelier/.ignore` (from `search_ignore`) instead of appending to the
    project's root `.gitignore` / `.ignore`. git and ripgrep/fd honor nested
    ignore files, so the rules still apply to every `<pm_id>` while the project
    root stays pristine, churn-free across framework upgrades, and free of merge
    conflicts for other contributors. A pre-DEC-051 root block is migrated away
    on setup/migrate (and a Garelier-created root file is removed if it becomes
    empty); removing the last PM drops the orphaned nested files. `doctor`'s
    worktree-ignored check is unchanged (`git check-ignore` is
    location-agnostic). Templates `runtime_gitignore` / `search_ignore` were
    rewritten to the nested (`*/runtime/` …) form; `target/` was dropped from
    the search ignore (it is the project's own concern, not Garelier's).

- **Both lanes now integrate through `studio` (DEC-045).** Artisan no longer
  has a direct-to-target exception: it creates `satchel` from `studio`, passes
  Guardian then Observer, integrates into `studio`, and reports to PM. Dock-lane
  candidates use the corresponding producer → Guardian → Observer → Dock path,
  including post-merge Smith hardening. Every `studio` → `target` promote now
  has one execution boundary: explicit user instruction, PM approval, and
  Concierge execution, with no PM fallback.

- **Rebrand to Garelier (DEC-050).** The framework is renamed
  Symphorie → **Garelier** (Garage + Atelier), and three vocabulary terms move
  to the workshop metaphor: **Orchestra → Dock** (role; orchestra lane → dock
  lane; `_orchestra`→`_dock`; `runtime/orchestra`→`runtime/dock`;
  `orchestra_*` config keys → `dock_*`), **Soloist → Artisan** (role; soloist
  lane → artisan lane; `_soloist`→`_artisan`; `[soloist]` config → `[artisan]`),
  and the Artisan-owned **`instrument` branch → `satchel` branch**. The brand
  rename also covers `__symphorie/`→`__garelier/`, `skills/symphorie-*`→
  `skills/garelier-*`, `SYMPHORIE_*`→`GARELIER_*`, the `symphorie/<slug>/…`
  branch namespace → `garelier/<slug>/…`, and the default exile home
  `~/.symphorie/`→`~/.garelier/`. The generic tagline word "orchestration" is
  reworded to "coordination" so no musical residue remains. Pure rename — no
  protocol, state-machine, retention, output-control, or layout semantics
  changed. Existing deployments migrate in place (branch rename + directory move
  + `git worktree repair` + config/runtime token rewrite).

### Added

- **Dispatch-only public build — headless driver disabled (DEC-061).** This
  release runs roles via dispatch only: in-session subagents (Claude) or a
  synchronous `codex exec` producer. The headless `claude -p` per-iteration
  driver (`supervise_pm`, `start_driver.{sh,ps1}`, the driver entrypoint) is
  **disabled and refuses to launch**; the driver code is retained but not run.
  Earlier driver/autonomy entries (Mode A/B, the `[execution] backend` axis)
  below describe internal development history and do not ship as a live default.
  See `docs/execution_backends.md`.

- **Dispatch via in-session subagent/Workflow dispatch — the default
  execution mode (DEC-057, supersedes the DEC-052 PTY bays).** An attended
  interactive PM/Dock session dispatches each role iteration as a first-party
  in-session subagent (Agent/Workflow tool), run-to-completion with no idle-bay
  wake and no deadlock. This is now the framework-level execution default.
  Procedure: `garelier-dock/references/role_subagent_dispatch.md`.

- **Codex (and pool) producers in dispatch (DEC-058).** Any role can run as a
  synchronous `codex exec` run-to-completion subprocess
  (`dispatch_codex_producer.sh`) under the Claude Dock, exercised with a
  read-only Codex Scout. Long quality gates (e.g. a multi-minute build) are
  Dock-run, not producer-run (producers reliably complete a bounded edit
  + quick sanity).

- **Mode D — gated self-pacing Dock auto-loop (DEC-059); default autonomous run
  mode.** One attended interactive PM session plus a self-paced `/loop` Dock
  tick (OBSERVE→DISPATCH→INTEGRATE→RECORD) with a per-tick parallel fan-out cap
  and a gate detector that HALTS-to-human at four named gates
  (engine-core/protected-path, scope expansion, promote, ambiguous-blocker),
  parking only the affected thread while others keep flowing. The mode taxonomy
  is refined to two canonical modes — **Mode B** (interactive PM + headless
  driver) and **Mode D** (interactive PM + dispatch); Mode A's "auto-proceed on
  PM judgment" survives as an autonomy setting within B/D, and Mode C folds into
  D. `[autonomy] mode = "b"|"d"`, `fan_out_cap`, `protected_paths` added.

- **All-Codex dispatch roadmap (DEC-060, proposed).** Records the direction and
  validation gate for running dispatch end-to-end on Codex alone (Codex as
  Dock, zero Claude): producers are already Codex-capable; the
  Dock path is gated on billing confirmation, Codex-facing skill
  delivery (AGENTS.md, no SKILL loader), and a Codex tick driver.

- **Prompt-injection hardening — untrusted external content is DATA, not
  instructions (framework invariant).** New keystone
  `garelier-core/references/untrusted_input.md` and protocol §1.10 tier-8 rule;
  a Librarian-owned, Guardian-read `injection_patterns.toml` registry plus a
  Guardian light-check; per-role pre-flight caveats on every ingesting role
  (Scout/Artisan web research, Librarian source-sync/import, Concierge
  ingestion, PM delegated-request bodies) and the `docs/concepts.md` threat
  model. Embedded agent-/tool-directed imperatives in a synced/imported/
  inspected artifact are flagged (`PASS_WITH_NOTES`) or `BLOCK`ed if they would
  weaken a rule or trigger an external action.

- **Open-source publish readiness.** `NOTICE` (Apache-2.0 attribution +
  third-party SPDX list), plugin/marketplace owner metadata, and a history-free
  publish export with a sensitive-content gate (`scripts/make-public-export.sh`:
  secrets / real emails / private identifiers / dead links into the excluded
  dogfood tree). License allowlist/denylist reconcile (MPL-2.0 moved to
  case-by-case review) and ToS honesty per the DEC-052 posture — the operator is
  responsible for their provider's terms; Garelier self-certifies no
  configuration as "ToS-clean" and ships no provider-endorsement wording.

- **Garelier small starters + unified control/library contracts (DEC-044).**
  `garelier-control-project` (renamed from `garelier-project-control`) now teaches a normally launched Claude Code/Codex
  session to manage the canonical `__garelier/<pm_id>/control/` tree, defaulting
  to the single-user `_workshop` id, which full setup can upgrade and continue
  using for Artisan or dock lanes. New
  **`garelier-control-library`** similarly teaches progressive, token-bounded
  knowledge retrieval and curation over the same `docs/garelier/` trees used by
  the full Librarian. Full and standalone modes share canonical milestone /
  decision / knowledge-document templates, clean bundle import/export, messy
  import staging, open-only git-history-backed backlog rules, coherent commit
  checkpoints, and derived Control/Knowledge graphs with validators. Knowledge
  retrieval explicitly forbids full-tree preload: role/category indexes and
  graph metadata narrow the smallest necessary topic sections first. Project
  Control, Library Control, and their combined use are the three minimum
  offering patterns; compact handoff and control-only diagnosis are built into
  Project Control rather than exposed as extra skills. This framework
  repository now uses the same canonical control-only
  `__garelier/<pm_id>/control/` layout for its own planning state.
  The standalone management plane is named **Garelier Control**. Composed
  execution offerings are called **Garelier Plugin Artisan** and **Garelier
  Plugin Full Garelier**; `Plugin` is a product/composition designation, not a
  skill-folder or technical package prefix.

- **Token-efficiency pass (DEC-042).** Direction: (1) **the framework requires
  no API key or specific billing plan**; (2) **it builds no capacity governor** —
  a session simply stops when the provider's usage limit is reached; (3) **model +
  effort stay the user's choice** — no framework model-tiering/downgrade;
  `opus`/`xhigh` on every role is first-class; (4) **efficiency = token reduction
  at the fixed model** — prompt-cache discipline, context-diet tightening,
  wasteful-iteration hygiene, and a read-only **efficiency dashboard**
  (tokens/iteration, cache-hit ratio, per-role token/cost, action-kind mix) over
  the existing `runtime/driver/usage/*.jsonl`. `[execution] backend` selects how
  each role iteration runs (`headless` default; `codex` alternative).
  *(implemented: driver + status-web + wizard/doctor + config)*

- **Dispatch execution backend removed (DEC-052).** The interactive-session
  `claude-dispatch` backend that DEC-042 originally shipped as the default
  (`backend = "dispatch"`, `acknowledge_attended_dispatch`, `dispatch_mux`,
  `dispatch_layout`, the Status Web "Cargo Bay" viewer) has been removed; the
  default *driver* backend is now `headless`. Dispatch later returned via a
  different, non-PTY mechanism — the in-session subagent/Workflow dispatch
  (DEC-057, above) — which is now the framework-level execution default.

- **Role knowledge index + control/knowledge import-export (DEC-048).** Three
  related data-management capabilities, all templates + scripts + skill
  instructions (no new Skills — the DEC-029 CI lint stays green):
  - **Role index** — `docs/garelier/knowledge/role_index.toml` is the inverse
    (by-role) axis of the DEC-029 topic trees and the single source of truth for
    the role→docs mapping. Every role reads its `read_first` set before a
    non-trivial task (wired once via `correct_operation.md`); Artisan's entry is
    the union of Worker ∪ Smith. A new read-only **`knowledge_query`** lets a role
    ask the Librarian to search the curated trees (compact pointers) when its
    `read_first` set doesn't resolve a question — free web research stays Scout's.
    A CI lint keeps `role_index` consistent with the topic trees.
  - **PM control import/export** — `control_export` / `control_import` (sh+ps1)
    snapshot and restore a PM's tracked `control/` authority as a portable bundle
    (`control_bundle_manifest.toml`). Input/output are mandatory explicit args;
    `runtime/` is excluded; import is dry-run by default and NO-OVERWRITE. Local
    bundle is PM-direct; leaving the sandbox is Concierge+Guardian; another PM is
    `request_intake` (DEC-006).
  - **Librarian knowledge import/export** — `knowledge_export` / `knowledge_import`
    (sh+ps1) move curated knowledge between projects. Export emits only tracked,
    license/PII-clean content (never `runtime/librarian/{raw,cache,drafts}`).
    Import is not a free adoption: it stages into the local-only working area +
    emits a conservative `source_registry` stub for shelf-branch review (confirm
    license, register source, rule conflict → BLOCK + escalate to PM).
  - **Provenance / rights guard** — `docs/garelier/security/
    provenance_rights_policy.md` defines the low-token rule for external-source
    adoption: original project wording, source registry authority/license/use/
    `last_reviewed_at`, unknown/not-adoptable material stays local-only and is
    not exported. `knowledge_export` now hard-refuses `license = "unknown"` or
    `"not-adoptable"` while keeping missing legacy metadata as a manifest warning,
    and `scripts/check_knowledge_safety.ts` locks the template/CI contract.
  *(implementation wave)*

- **Forward-integration: `studio` → in-flight workbenches (DEC-039 / DEC-039).**
  Base tracking was one-directional (`target → studio`), so a long-running Worker
  drifted from `studio` (kept the tip it branched from until merge time). A fourth
  base-tracking flow now keeps in-flight `workbench`/`anvil` branches current:
  **Dock-triggered, producer-performed** — each iteration Dock checks
  whether an in-flight branch is behind `studio` and, if so (default ≥ 3 commits,
  or a significant shared-file merge), drops an **idempotent** `track-target.md`;
  the Worker/Smith merges `studio` in at its next iteration boundary and resolves
  conflicts **itself** (it owns the code — Dock's no-code-writing exception is
  not widened; it only triggers + verifies). The trigger/detect mechanism existed
  but was advisory (Dock §8.5/§8.6, Worker §6.5); this makes it a systematic
  per-iteration duty. Merge, never rebase; the merge gate stays one-way. *(spec)*

- **Librarian storage split — tracked vs local-only (DEC-038).** The Librarian's
  curated, shareable knowledge stays **tracked/committed** in the
  `docs/garelier/<category>/` trees (+ runbooks/manuals/registries, promoted via
  a `shelf` branch + Dock review). A new **local-only (gitignored,
  machine-local, never committed)** working area at
  `__garelier/<pm_id>/runtime/librarian/` holds `raw/` (raw external pulls),
  `cache/` (per-source sync caches), and `drafts/` (pre-publication drafts) —
  work happens there, then only the generalized, license-clean result is promoted
  into the tracked tree (raw external content is never committed: license/size/PII
  risk). Mirrors the control/runtime split. The setup wizard (sh+ps1) seeds the
  area + a local README (gitignored by the existing `__garelier/*/runtime/` rule,
  so no `.gitignore` change); the Librarian SKILL §2, layout docs (CLAUDE.md,
  protocol.md ×2), and DEC-029 document it; the console's Knowledge page shows
  the committed-vs-local split. *(implementation wave)*

- **Status Web Console overhaul — situational awareness without reading runtime
  files.** The read-only console (`driver/src/status_web.ts`) now centers on a
  LAN-watching **Dashboard** (health, rate-limit/blocker warnings,
  LAN-vs-loopback access mode, driver/lane/merge-gate cards, a unified live work
  board, agents, recent reports) and a detailed
  **Work** surface (execution board, active/held-future milestone queues,
  in-flight assignments, tier congestion, role capacity, lane lock). **Flow** is a static
  command-chain / lane explanation
  with corrected Observer/Guardian placement as shared read-only sidecars/gates
  that apply in both dock and artisan lanes. The **Guide** page resolves
  from bundled skill docs and now has EN/JP copies; description prose defaults
  to Japanese while headings, role names, states, and chips stay English to
  match runtime files/logs. **Reports** rows open full reports in a modal;
  **Files** browses this PM's `__garelier/<pm_id>/` subtree (runtime
  reports/inboxes/manifest/blueprints/STATE — `checkout/`+`.git` pruned,
  secret-redacted); **Branches** documents every branch family + namespace.
  **Agents/Roles** now shows the stable slot id beside provider/model so an
  operator can see e.g. `worker-02` is currently run by `codex-cli`. Default
  templates/docs now recommend provider-neutral slot IDs (`worker-01`,
  `scout-01`, `smith-01`, `artisan-01`) instead of provider-derived IDs such as
  `claude-a`, making provider swaps reuse the same role container. A
  light/dark **theme toggle** (default light; persisted) was added. The console
  binds **LAN-reachable by default** (`--loopback` opts out) and writes a pidfile
  so `start_status`/`stop_status` `.sh`/`.ps1` helpers can stop a detached
  console. New parsers (`status_overview`/`status_queue`/`status_knowledge`/
  `md_tables`) ship with unit tests. *(implementation wave)*

- **Cross-artifact consistency — a generalized Smith test perspective.** The
  post-merge consistency defects a 15-finding audit surfaced (dangling
  references, superseded-but-unmarked decisions, sh/ps1 parser drift, ownership
  /branch tables missing rows, a config field nothing reads, stale labels) are
  generalized into a reusable Librarian-managed quality-tree knowledge file,
  `docs/garelier/quality/cross_artifact_consistency.md` (seeded from
  `skills/garelier-librarian/templates/quality/`). Seven dimensions —
  reference integrity, mirror agreement, dual-implementation parity, enumeration
  completeness, declaration↔consumer agreement, lifecycle hygiene, label/version
  drift — plus the verify-before-claiming discipline ("a search is a hypothesis,
  not a verdict"). Smith reads it before hardening (`garelier-smith` §1/§2);
  `test_strategy.md` lists it as a test kind; `assignment.md`/`report.md` carry an
  optional Smith criterion. Knowledge lives in the tree (DEC-029), not in the
  Skill; reuses DEC-014 (Smith spec-consistency) — no new mechanism.

- **Gemini / Cursor are first-class providers (DEC-033).** Their permission
  profiles are now wired to the CLIs' real flags — Gemini `safe`→`--approval-mode
  default`, `reviewed`→`--approval-mode auto_edit --sandbox`, `dangerous`→`--yolo`;
  Cursor `reviewed`/`dangerous`→`--force` — so they work on **every** role
  including Worker / Smith / Artisan / Concierge, not just read-only ones. The
  flags are version-sensitive: the provider smoke verifies them against the
  installed CLI, and `GARELIER_PROVIDER_<KIND>_PERMISSION=off` falls back to no
  permission flag (still bounded by worktrees + gates) if a version rejects one.
  doctor's old P1 "prefer read-only roles" is now a P2 advisory to **verify via the
  smoke**, not avoid. (Corrects the DEC-026 framing that read as "unusable for
  write roles.")

- **Thin role-skill entrypoints (DEC-032).** The large role skills now follow the
  PM/Dock pattern — a small `SKILL.md` entrypoint (frontmatter + pre-flight +
  role contract + state-machine overview + MUST BLOCK IF + a routing table + See
  also) with the detailed per-state procedures moved **verbatim** into
  `references/*.md`. Worker 32.8→11.3 KB, Scout 21.4→11.5, Concierge 21.4→13.2,
  Observer 19.2→13.7, Artisan 15.7→9.4. Less context loaded per skill activation
  and less conversation-log bloat (the Output Control spirit), with the hard rules
  kept in the always-loaded entrypoint. Documentation restructure only — content
  moved, not lost; cross-skill section references updated.

- **Thin `garelier-core` entrypoint (DEC-034).** The reference library's
  `SKILL.md` (the largest skill file, ~27 KB) becomes a lean index (~7 KB:
  frontmatter + When-reading + Reading order + Reference routing + Vocabulary +
  See also). The framework-invariant detail moves **verbatim** to
  `skills/garelier-core/references/`: `branches-and-layout.md`,
  `roles-and-lanes.md`, `execution-and-operations.md`. The DEC-022 subagent
  guidance moves to the Librarian **system** tree
  (`docs/garelier/system/subagent_execution.md`) — it is Claude-Code-only
  (Codex has no subagents, DEC-013) and is execution reasoning, so the tree is
  its right home. `SKILL.md` stays the Codex entrypoint and `protocol.md` (always
  read) keeps the operational invariants, so Codex coverage is preserved; the
  routing table reaches the references like DEC-032. Documentation restructure
  only — content moved, not lost.

- **Role worktrees in-project by default (DEC-036, supersedes 0035).** DEC-035
  moved role worktrees OUTSIDE the project to a machine-local studio home; that
  broke Claude Code's launch-folder access model — interactive / policy-sandboxed
  writes outside the project are denied, which doesn't degrade quality but
  **stalls the state machine** (the role can't write `../STATE.md`) — and it
  couldn't run in shared/restricted environments or keep the project
  self-contained. DEC-036 reverts the relocation: role git worktrees live
  in-project again at `<proj>/__garelier/<pm>/_<role>/<id>/checkout/` (DEC-020
  layout). The CLAUDE.md ancestry duplicate DEC-035 fixed is only a token cost
  (identity is prompt-authoritative via `--append-system-prompt-file`) and is now
  neutralized **in-project** with the official `claudeMdExcludes` setting (written
  to `<checkout>/.claude/settings.local.json`, added to the worktree's
  `info/exclude`; honored in headless `claude -p`). Exile is retained as an
  explicit opt-in (`--exile` / `-Exile` / `GARELIER_HOME` / `[workspace]
  home_root`). `--mode migrate` is now bidirectional — by default it relocates
  exiled roles BACK into the project. The `workspace.ts roleContainer` resolver,
  the wizard `ws_*` / `Get-Ws*` helpers, and the doctor/status pointer resolvers
  are kept (they serve the opt-in exile path and resolve to in-project when the
  pointer is absent). DEC-035 Part A (prompt-authoritative identity) stands.

- **Priority tiers + FIFO + urgent override for the scheduler (DEC-031).** The
  DEC-027 flat priority list becomes **priority tiers** (distinct from the DEC
  0017 execution *lanes*): `[concurrency].priority` → `tiers` (array of role
  groups). Default, highest first: gates (concierge/guardian/observer), then
  smith+librarian, then worker+scout+artisan (Worker/Scout decide by FIFO; Artisan
  never competes — it correctly sits low and yields to its own gates), then a
  **reserved empty demotion tier** Dock can park a producer in (e.g. push
  Smith below busy Workers, then restore it, via
  `runtime/dock/tier_order.json`). Within a tier, the **longest-waiting agent
  runs first (FIFO)** — fair for multiple Workers. Cross-tier **aging** still
  breaks starvation. A per-task **`urgent.md`** marker (PM/Dock-written for a
  user "do this first" / "do AAA, BBB, CCC first") promotes one instance into a
  **reserved urgent lane above all tiers** — multiple urgents run FIFO, it never
  competes with the gate tier, and it **never preempts** (running agents finish;
  urgent = next free slot). Fixes the prior flat default that wrongly put Artisan
  at the top. Breaking config change (no legacy concern). Driver pure cores +
  tests, setup_config template + wizard (sh/ps1).

- **Mechanical Concierge external-operation guards (DEC-030).** The Concierge's
  external-write prohibitions are now enforced at the git layer, not just by the
  prompt. A per-worktree `pre-push` hook (installed by
  `install_concierge_guards.{sh,ps1}` via a scoped `core.hooksPath`)
  **unconditionally** rejects any `garelier/*` push and any force / non-fast-
  forward push from the Concierge worktree — git aborts it no matter what the
  agent types, and it never touches the user's own git elsewhere.
  `concierge_git_guard.{sh,ps1}` is the sanctioned path for remote git: it refuses
  `git pull`, force-push flags, and `garelier/*` pushes, and its
  `preflight-target-push` mode fails closed unless the **live remote tip == the
  PM-approved expected SHA** (no drift) **and** a **PASS/PASS_WITH_NOTES Guardian
  verdict is bound to the exact HEAD** (`review_sha`) — stale, BLOCK, or absent
  verdicts are refused. `doctor` raises P0 `concierge-push-guard` if a Concierge
  worktree lacks the guard, so it cannot be silently absent. Smoke-verified end to
  end. Complements (does not replace) the `[concierge_policy]` flags, the merge
  gate's `review_sha` binding (DEC-024), and the target-scoped lock (DEC-025).

- **Librarian role knowledge trees + framework-wide commit hygiene (DEC-029).**
  Instead of new "convenience" Skills, added Librarian-managed reference-knowledge
  trees under `docs/garelier/{engineering,quality,review,system}` (plus an
  `index.md` for the existing security tree), following the security/ (DEC-024)
  and external_operations/ (DEC-025) pattern: generalized, original-wording
  project knowledge that gate/producing roles **read but never edit**. Role SKILLs
  gain only short reference conditions (Worker/Artisan → engineering+quality;
  Smith → quality; Observer → review, with new **User perspective** and **System
  impact** report sections; Guardian/Concierge → security; all roles → system) —
  never pasted knowledge bodies. No external skill/web text is copied; only
  PM-approved registered sources are generalized (a common
  `knowledge_update_request.md` routes updates; Librarian applies PM-approved
  changes on a `shelf` branch). The setup wizard seeds each tree into a target's
  `docs/garelier/<tree>/` (no-overwrite, sh/ps1); doctor flags a missing index;
  CI lint fails on a forbidden new-Skill directory. **Bundled (user request):** a
  no-secret/PII-in-commits policy — `security/commit_hygiene_policy.md` is the
  pre-commit runbook and `correct_operation.md` item 11 makes running it a
  correctness criterion for every committing role (the Guardian gate is the
  backstop).

- **Output Control — bounded final responses, log excerpts, usage summary
  (DEC-028).** A new `[output_control]` block bounds the provider's FINAL
  response length and the driver's JSONL log growth, on top of (not replacing)
  compact handoff and retention. Per-role profiles (`normal`/`compact`/`micro`)
  carry a `soft_result_chars` budget; the driver appends a short directive to the
  iteration prompt asking the provider to keep its final response short and put
  durable detail in official files — **never** abbreviating code/paths/commands/
  URLs/errors/SHAs and **never** hiding risks/blockers/warnings/approvals
  (Guardian/Concierge default to `normal` so safety content is never pressured
  short). `model_result` is stored as a bounded excerpt with
  `result_chars`/`over_budget`; an over-budget response WARNs `output_budget_exceeded`
  (the result used for role-state decisions is never truncated). One usage record
  per OK iteration lands in `runtime/driver/usage/YYYY-MM.jsonl`; driver/role JSONL
  logs rotate by size. Wired through config normalize (ConfigError on unknown
  profile/violation_mode/`soft_result_chars < 200`), setup wizard
  (fresh/diff/migrate, sh/ps1), doctor, and status. `violation_mode = "fail"` is
  experimental; default `warn`.

- **Detached-agent concurrency cap + priority scheduling (DEC-027).** A new
  `[concurrency]` block bounds how many detached provider CLIs run at once so
  enabling every role does not exhaust machine memory. `max_concurrent_agents`
  (default 4; 0 = unlimited), `priority` (default unblocks the merge/promote/gate
  path before bulk producers, ephemeral roles last), and `starvation_cycles`
  (default 3). Each poll the driver COUNTs live leases → budget, GATHERs runnable
  candidates with a **non-mutating** `ChangeTracker.peekChanged` (so a deferred
  candidate is never stranded), then SCHEDULEs by (aging, priority, key),
  launching up to budget and deferring the rest with aging so no role starves.
  PM, Dock, and the merge-gate subprocess are **uncapped**. The cap is a
  hard memory ceiling that holds across a driver restart (surviving children are
  counted). Wiring: driver pure cores + tests, `setup_config.toml` template,
  setup wizard (fresh/diff/migrate, sh/ps1), `doctor` (disabled/invalid cap),
  and `status` (`alive / cap detached agents`).

- **Provider pool via a Provider Adapter Registry (DEC-026).** The driver
  gained a `providers/` registry; `role.ts` no longer branches on provider kind
  (Claude Code + Codex CLI moved verbatim behind adapters, test-locked). Added
  **`gemini-cli` / `copilot-cli` / `cursor-cli`** as adapters: `ProviderKind` is
  now five, `normalizeProvider` accepts their aliases, the setup wizard
  (sh/ps1) provider-normalize + ambiguous-`id:provider` guard cover them, and
  `AgentDef.provider_command` / `GARELIER_PROVIDER_<KIND>_CMD` give a per-agent /
  per-provider spawn override. The typed registry makes a missing adapter a
  compile error (config can't accept a provider the driver can't run).
  New-provider CLI flags are isolated per adapter and finalized by a provider
  smoke; Cursor is experimental (read-only roles first). **Governance is
  unchanged** — providers are role executors, never above the role boundaries,
  permission profiles, Guardian gate, or Concierge external-op policy;
  `--allow-all`/`--yolo` are not used by normal roles and external writes stay
  the Concierge's job. `doctor` flags a configured-but-missing provider CLI (P1);
  a mock-based provider smoke round-trips all five adapters (build → spawn →
  parse) in CI, and `provider_smoke.ts --provider <kind>` smokes a real CLI.

- **Concierge / clipboard external-operations role (DEC-025), Phase 1.** A new
  PM-dispatched **Concierge** — PM's catch-all *delegate of last resort* — on a
  local-only `clipboard` branch executes work that leaves Garelier's sandbox.
  **Phase 1 moves the promote execution off PM onto the Concierge**: PM decides,
  base-tracks (it owns `studio`), and supervises; the Concierge merges
  `studio`→`<target>` in its own worktree, runs the quality gate on the merged
  tree, tags, and pushes — consuming the Guardian `promote_gate` verdict (no new
  gate kind), holding a target-scoped lock under `runtime/concierge/locks/`, and reading
  Librarian-owned `docs/garelier/external_operations/` knowledge. It never
  implements source, decides policy, gates, pushes `garelier/*`, force-pushes,
  or runs a blind `git pull`; if a task fits an existing role it hands back to
  PM. With no Concierge configured, PM performs the promote itself (fallback).
  Wired through the driver (`concierge` role type / config / prompt / status),
  `setup_wizard --concierges` (sh+ps1 parity, default-disabled), and `doctor`
  (concierge-policy / concierge-safety / concierge-report-leak P0s). Phase 2
  (PR / release / ticket / artifact / remote-sync) ships incrementally,
  **default-disabled** (off unless `allowed_operation_kinds` grants the kind) and
  **safe-degrading** (NO_OP + BLOCK when the platform CLI is absent — parity
  across Claude Code / Codex CLI); the **pull-request** flow is the first
  increment (Librarian `pull_request_policy.md` + `runbooks/create_pr.md` +
  `templates/pull_request_body.md`, with the remote head on a `pr/<pm_id>/<slug>`
  prefix, never `garelier/*`); the **release** flow is the second
  (`release_policy.md` + `runbooks/create_release.md` + `templates/release_note.md`
  — strongest gate: fixed tag + `target_sha`, Guardian gate, artifact manifest +
  scan, no tag clobber, mandatory rollback note); the **ticket** flow is the
  third (`ticket_policy.md` + `runbooks/update_ticket.md` + `templates/
  ticket_update.md` — the investigate-then-execute shape: read the ticket, apply
  the PM-fixed method, hand back to PM if it needs source changes); the
  **remote-sync** flow is the fourth (`runbooks/sync_remote.md` — read-only
  `fetch`/status/log is Phase 1; a merge/rebase/push **write** tier is Phase 2
  and runs only the exact command the assignment names, never `git pull`, never
  force, never a `garelier/*` push). `check_external_ci` is a read-only helper
  (CI status only; no gate, but still needs the platform CLI). A resilience pass
  (interruption / rate-limit / user-stop / restart, 30+ scenarios) added a
  **reconcile-before-re-attempt** recovery step to the Concierge (SKILL §10.5):
  on restart it checks whether the external effect already landed (target tip /
  existing PR / existing tag-release / ticket state) before acting, so a
  crash-after-write is self-reconciling — never a double push / duplicate PR; the
  `create_pr` runbook gained the matching existing-PR idempotency check. The
  driver gained a **per-role failure circuit breaker** (consecutive non-rate-limit
  failures back off 1m→2m→…→30m instead of re-launching a permanently-broken role
  every poll; resets on success or restart), and `doctor` now flags a **stale
  Concierge lock** (dead-pid owner, P1) alongside the lane.lock check. The driver
  also **auto-clears a provably-orphaned `lane.lock`** (dead-pid owner, no active
  Artisan) so a crashed lane holder cannot block the whole dock lane, and the
  Concierge external lock is **target-scoped** (`<target>` / `pr__…` / `release__…`
  / `ticket__…`) so same-target ops still serialize but independent targets run in
  parallel. Scenarios C-01…C-30. The same pass also backfilled
  pre-existing Guardian gaps (status display, driver skill-doc loading,
  status-snapshot, state-machine intro).

- **Guardian / gavel security gate (DEC-024).** A new commit-free **Guardian**
  role on an ephemeral `gavel` branch is the security / privacy / dependency /
  license **GATE**. It reads **Librarian-owned** security knowledge — seeded at
  `docs/garelier/security/` (commercial-friendly license allow/deny, secret &
  PII patterns, exception registries, scanner/incident runbooks) — and applies
  it to a diff, emitting `PASS` / `PASS_WITH_NOTES` / `BLOCK` / `NO_OPINION`.
  Applying a rule is separated from changing a rule (Librarian owns the
  knowledge; Guardian raises a `knowledge_update_request`, never self-approves).
  The **merge gate REFUSES** a merge that mechanically requires a Guardian
  (security-sensitive path / package manifest-lockfile / protected path) without
  a passing verdict — checked **before** the Observer gate, and the verdict is
  read from the report (`verdict:`), so a request cannot claim a PASS the report
  lacks. Evidence is **redacted / pointer-only**. Disabled by default
  (`[guardian_policy].enabled=false`); `doctor` flags enabled-but-no-guardians
  (P0). The driver runs Guardian commit-free and lane-agnostic (like Observer);
  the security knowledge is seeded by the setup wizard. Observer's security
  triggers move to Guardian; Smith keeps remediation. The merge gate also
  binds the verdict to `review_sha` — a verdict that reviewed an older commit
  than the live workbench tip is refused as **stale** (G-15), in both the Bun
  and PowerShell gates. The setup wizards (`setup_wizard.{sh,ps1}`) accept
  `--guardians "<id:model,...>"` to seed/reconcile the Guardian set and emit
  the `[guardian_policy]` / `[guardian_tools]` sections (disabled by default).
  `doctor` adds an **output-safety P0** (`guardian-report-leak`, G-14): it
  scans Guardian report areas for high-confidence secret formats (private keys,
  cloud/provider tokens, JWTs) so a report cannot silently become the leak —
  redaction placeholders never match. Both `doctor.sh` and `doctor.ps1`.

- **Driver unit test suite + repo CI gate.** First automated regression
  coverage for the Bun driver — **50 tests** across `config.test.ts`,
  `state.test.ts`, `prompts.test.ts`, `scheduling.test.ts`,
  `status_snapshot.test.ts` (zero new deps; Bun's built-in runner). Covers:
  config parsing (stack-driven quality gate, permission profiles,
  `[observer_policy]`, `[[observers]]` with the `enabled` filter + default
  kinds, artisan enable/disable, provider validation), the
  `OBSERVING`/`ACKED` state additions + `isAgentActive` + interest paths,
  per-role prompt construction for all eight roles, scheduling predicates
  (`observerShouldRun`, observer-only states not triggering commit roles,
  `readLaneLock`), and the status-console snapshot (Observer role coverage,
  merge-gate success/failed/conflict, lane parsing, secret redaction).
  `main.ts` now guards its entry with `import.meta.main` so it is
  importable by tests without starting the driver. A repo-root **`ci.sh`**
  runs the full gate — `tsc` + `bun test` + `bash -n` on every `*.sh` +
  PowerShell parse on every `*.ps1` + a wizard fresh-setup smoke
  (throwaway git repo → driver `loadConfig` parse) — and a
  **`.github/workflows/ci.yml`** runs it on Linux plus a Windows
  PowerShell-parse job. Run locally with `bash ci.sh`.

- **Observer role (DEC-019).** A new `garelier-observer` skill adds a
  commit-free, read-only **review/advice sidecar** that runs in *both*
  lanes (it never takes `lane.lock` and merges nothing). It is requested
  by Dock (before merging Worker/Smith/Librarian output), Artisan
  (before merging `satchel` into `target` — required by default), and
  Worker (non-binding, scope-bounded code-direction advice). Verdicts:
  `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` /
  `NO_OPINION`; mandatory gates are governed by `[observer_policy]`, and a
  `BLOCK` always escalates to PM (never waivable). State machine
  `IDLE→ASSIGNED→OBSERVING→REPORTING→ACKED→IDLE` (+`BLOCKED`, `ABORTED`;
  no rework/merge). Ships SKILL + references (review-policy,
  direction-advice) + templates (observer assignment/report, direction
  advice). Driver gained an `observer` `RoleKind`, `[[observers]]` /
  `[observer_policy]` config, observer interest paths, `OBSERVING`/`ACKED`
  states, a both-lanes detached sidecar job, and status-console display.
  Dock review (§7.5), Artisan pre-merge (§7.5), and Worker
  (§5.2.1) skills gained the request hooks. The setup wizards
  (bash + PowerShell) fresh mode creates `_observers/<id>` worktrees,
  scaffolds `runtime/observer/` + `control/observations`, accepts
  `--observers` / `-Observers`, and emits enabled `[[observers]]` +
  `[observer_policy]` (auto-enabled when observers are configured) —
  smoke-tested end-to-end (fresh setup → driver `loadConfig` parse →
  `doctor`). Diff mode also reconciles Librarians/Observers (same
  desired-set semantics as Smiths) and toggles the artisan lane via
  `--artisan` / `--no-artisan` (`-Artisan` / `-NoArtisan`), creating or
  removing the role worktrees and scaffolding `runtime/observer/` +
  `control/observations/` on the first observer — verified end-to-end in
  both shells (fresh → diff swap/remove/re-add → driver `loadConfig`
  parse → idempotent re-run).

- **`doctor` health check (P0-6).** `garelier-core/scripts/doctor.{sh,ps1}`
  read-only-inspect one PM's install and report findings by severity
  (P0 blocking / P1 warning / P2 advisory): placeholder leakage, undefined
  or stack-mismatched quality gate, `dangerous` permission profile, unset
  protected paths, role-worktree↔config mismatch, stale `lane.lock`, stale
  driver leases, and version drift. Exit code is non-zero on any P0;
  `start_driver.{sh,ps1}` now run doctor as a pre-flight and refuse to
  launch on a P0 unless `--force` / `-Force` is given.

- **Status Web Console (read-only).** A local, browser-based view of a
  PM's state — lane (`idle`/`artisan`/`dock`), driver, active branch,
  merge gate, role table with leases, recent reports, source/routine
  registries, and warnings (stale pid, stale `lane.lock`, failed quality
  gate, unresolved review). Implemented with **Bun built-ins + vanilla
  HTML/CSS/JS only** — zero third-party HTTP/UI dependency, so no copyleft
  enters the tree. Binds to **loopback only**, is **read-only** (no
  operation endpoints), **consumes no AI tokens**, redacts secrets from
  served content, serves docs from a fixed allowlist (no arbitrary file
  reads), and builds its snapshot best-effort (a missing/corrupt file is a
  warning, not a crash). New driver files: `status_types.ts`,
  `status_snapshot.ts`, `status_server.ts`, `status_web.ts`, and
  `static/{index.html,app.css,app.js}`; a `[status_web]` config block; a
  `bun run status` script; and `docs/web_console.md`. Start with
  `bun run status -- --pm-id <pm_id>` → `http://127.0.0.1:3787/`.

- **Librarian role (DEC-018).** A new `garelier-librarian` skill adds a
  dock-lane "bookshelf" role on a `shelf` branch
  (`garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`, merged through
  Dock review — never directly to target). It does two jobs: (1)
  fetch external info from **registered** sources
  (`docs/garelier/knowledge/source_registry.toml`) and reflect it into
  internal docs Markdown **with project-specific augmentation** and
  provenance front matter; (2) standardize repeatable work into
  runbooks/manuals registered in
  `docs/garelier/knowledge/routine_registry.toml` (each routine's
  `default_role` is the PM re-dispatch hook). Boundaries: no free research
  (Scout), no feature code (Worker/Artisan), no QA (Smith), no unregistered
  sources, no rule-meaning changes, no stale-overwrite on fetch failure.
  Ships SKILL.md + references (registries-and-runbooks, source-sync) +
  templates (source_registry, routine_registry, runbook, librarian
  assignment/report). The driver gained a `librarian` `RoleKind`, a
  `[[librarians]]` config array (with `enabled`), librarian interest paths,
  and a detached lease; Dock gained Librarian dispatch, inbox routing,
  and a **Librarian Review** (§7.4) before the merge gate.

- **Artisan role and the artisan/dock lane split (DEC-017).** A new
  `garelier-artisan` skill defines the **artisan lane**: a single agent
  that performs the combined Dock + Worker + Smith + Librarian scope
  by itself for one task, on a `satchel` branch
  (`garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>`), and merges
  it **directly into `<target>`** after its own quality gate + coverage
  audits — a deliberate, bounded exception to the "Worker never merges its
  own branch" / "studio→target only via promote" rules. The artisan lane
  and the dock lane are mutually exclusive, arbitrated by
  `runtime/lane.lock`. The Bun driver gained an `artisan` `RoleKind`, a
  `[artisan]` config block, artisan interest paths, a detached-agent lease
  with a `lane` field, lane gating in the poll cycle (artisan lane → PM +
  Artisan only; otherwise PM + dock roles), and a startup skill-doc
  check for `garelier-artisan`. PM gained lane-selection guidance
  (planning §4.6) and the blueprint template gained `Execution lane hint`
  / `Preferred role hint` / satchel+shelf expected outputs / a
  source-routine mapping section.

### Fixed

- **Garelier Control Bash lifecycle parity.** `init_library.sh` now renders the
  starter category index without malformed escaped-slash `sed` expressions,
  and `knowledge_export.sh` treats absent optional provenance as a manifest
  warning instead of exiting under `set -euo pipefail`. CI now executes the
  complete Bash lifecycle: consolidate, split, control export/import, and
  knowledge export/import.
- **Control-only Status Web helper parity.** Start, status, and stop helpers
  now auto-detect namespaces with `control/control.toml` even when no full
  `_pm/setup_config.toml` exists. CI launches the read-only server, verifies
  status plus health/control APIs, and stops it without an explicit `pm_id`.
- **Driver cost made proportional to progress — usage-explosion + rate-limit
  death-spiral fixed at the root (DEC-049).** In real operation the driver
  burned provider usage disproportionate to progress and a rate-limit loop
  eventually killed the run. Five root causes, fixed:
  - *Semantic wake.* PM/Dock woke on nearly every poll (~$1+/iteration, 1M+
    cache-read) only to conclude "no action", because the wake gate compared
    whole-file mtimes and producers re-stamp their `STATE.md` heartbeat each
    working iteration. `ChangeTracker` now keys on semantic `Signal` values:
    `statusSignal` (a producer's STATE.md → status line only) and `contentSignal`
    (dashboards → body hash minus dedicated "last updated" stamp lines). A
    coordinator wakes on a real transition / handoff / new merge-result / inbox
    item — never on heartbeat churn. (Pinned by a semantic-wake test suite; an
    adversarial review caught and fixed a PM-stall regression in the first cut.)
  - *Rate-limit brake.* A rate-limited role only bumped a global counter and
    re-launched every poll, re-hitting the limit (the fatal spiral). Now each
    role parks for a self-expiring window (`rateLimitBackoffMs`: 1m→…→30m cap),
    symmetric to the failure circuit breaker; a cleared limit always resumes.
  - *Producer auto-fix.* A one-line `cargo fmt --check` violation forced the full
    merge gate (build + test) to re-run multiple times for one task. Producers
    now run a declared `[quality_gate.autofix]` formatter (per-stack default;
    granted to the producer allowlist) before REPORTING, fixing formatting at the
    source. *(implementation wave; merge-gate fast-first + coordinator context
    diet are the remaining DEC-049 levers.)*
- **Status Web false warnings, fixed at the root with a CI-enforced role-contract
  guard.** Two live false positives — a recovered/stale rate limit shown as active
  (`rate_limited_cleared` matched the "rate_limited" substring, and a plain
  stdout.log line fell back to the always-fresh file mtime for recency), and
  *"guardian guardian-01: REPORTING without report.md"* (Guardian writes
  `guardian_report.md`, Concierge `concierge_report.md`; only producer/sidecar
  roles write the generic `report.md`) — were both symptoms of one class: the
  status snapshot hardcoded role/file/event conventions that drift, unguarded,
  from the canonical role skills and the driver. Fixed the two bugs *and*
  externalized the conventions to a single source of truth (`role_contracts.ts`:
  report artifact per role, worktree-role set, rate-limit event names) consumed by
  the status snapshot, with `role_contracts.test.ts` CI-enforcing every entry —
  same pattern as DEC-048's git_command_policy SoT vs the driver grant. The guard
  asserts each role's report artifact matches its SKILL's write instruction (the
  Guardian/Concierge deviation), every `setup_config` `[[role]]` array maps to a
  status-handled role kind (a new role can't fall through), every `rate_limit*`
  event the driver emits is classified active-vs-cleared (a rename can't
  resurrect the bug), and no role's REPORTING state false-flags. The two injected
  bugs were verified to fail the guard before reverting. *(implementation wave)*

- **Provider rate-limit detection now covers Claude Code session-limit output.**
  Claude Code can return `You've hit your session limit ...` as the JSON
  `result` on a non-zero exit, not just in stderr/stdout. The driver now checks
  parsed provider result text as well, classifies it as `rate_limited`, applies
  the existing exponential backoff, and lets Status Web surface recent
  session-limit/rate-limit logs as a warning. *(implementation wave)*

- **Codex CLI and Guardian scanner grants match current tooling.** The Codex
  adapter no longer passes the removed `--ask-for-approval` flag; it uses the
  current config override form for `approval_policy="never"`. Claude Code
  Guardian runs in `reviewed` mode now also get a role-scoped `gitleaks`
  `--allowedTools` grant so the default mandatory secret scanner does not block
  every Guardian gate when the scanner is installed. *(implementation wave)*

- **`supervise_pm = true` no longer makes the driver kill itself after one PM
  iteration (SessionEnd self-stop).** The PM's `_pm/.claude/settings.json`
  `SessionEnd` hook touches `runtime/driver/stop` so a human `/quit` of the
  **interactive** PM stops the driver (hybrid mode). But under `supervise_pm =
  true` (the framework default) the driver runs PM **headlessly each poll**, and
  the unconditional hook fired on every headless PM session-end — touching the
  stop file and shutting the driver down after a single iteration. Because the
  default config combines `supervise_pm = true` with this hook, full-driver mode
  was effectively broken out of the box (observed as the driver "repeatedly
  stopping" with `stop_requested source="stop_file"`). Root fix: the driver now
  exports `GARELIER_DRIVER=1` for every provider session it spawns
  (`role.ts`), and the SessionEnd hook is gated `test -n "${GARELIER_DRIVER:-}"
  || { … touch …stop; }` so it fires ONLY for a human-run interactive PM (no
  such env). Updated in both `setup_wizard.sh` and `setup_wizard.ps1` (parity).
  See DEC-002 (autonomous mode via per-iteration driver). *(implementation wave)*

### Changed

- **Status Web now uses a consolidated LAN-watching dashboard.** The console's
  first screen is a lightweight vanilla JS/CSS `Dashboard` that combines health,
  rate-limit/blocker warnings, LAN-vs-loopback access mode, live work, queue,
  live agents, and recent reports. The detailed work view keeps role capacity
  and merges
  the old pipeline/queue split into one `Work` page; the old duplicate
  overview/status/pipeline/queue pages were removed from the client navigation.
  `[status_web] host = "0.0.0.0"` is now accepted and seeded so the documented
  LAN default matches the generated config. *(implementation wave)*

- **Status Web queue now separates active/unblocked milestone backlog from held
  future milestone backlog.** The `Dashboard` live work board and the detailed
  `Work` page split backlog into `ACTIVE QUEUE` and `FUTURE QUEUE`.
  Multiple active milestones can appear
  as dispatchable when they are safe to run in parallel; later dependency-held
  milestone backlog stays visible without looking dispatchable, so "capacity
  0/4 but nothing starts" can be understood as milestone/dependency gating
  instead of worker starvation. *(implementation wave)*

- **Status Web Work queue tables are now browseable backlog indexes.** Active
  and held-future queue tables paginate at 10 items and link blueprint names to
  the full Markdown blueprint modal, so long queues remain fully inspectable
  without leaving the Work page. *(ui)*

- **Status Web Routines/Sources empty states no longer read like hard file
  errors.** When `routine_registry.toml` / `source_registry.toml` has no
  registered entries yet, the pages now explain that the Librarian populates the
  registries after standardizing repeatable work or approving a source. *(ui)*

- **Status Web now exposes the role knowledge index by role and filters Files.**
  A new `Role Knowledge` page promotes
  `docs/garelier/knowledge/role_index.toml` into its own role-by-role view,
  showing each role's `read_first` / `on_demand` documents, missing paths, and
  click-to-open file bodies. The `Files` page also gains an incremental
  space-separated partial-match AND filter (for example, `docs md`). PM id,
  full project path, and LAN URLs/details are now screenshot-hidden by default
  behind explicit Show buttons. *(ui)*

- **Driver grants the protocol's git command set to `reviewed`-profile roles
  (claude adapter).** Dock's merge-gate conflict resolution (§8.1.B —
  `git checkout` studio + `git merge --no-ff --no-commit` + resolve + `git
  commit`), base tracking (§8.0), Worker/Smith drift-resync (§8.5/§8.6), and
  role commits all REQUIRE git. In the `reviewed` profile (`--permission-mode
  acceptEdits`) Claude auto-accepts file edits but still gates Bash on the
  project `.claude/settings.local.json` allowlist — so a stripped/incomplete
  allowlist silently blocked Dock from resolving a conflict (it bounced the
  Worker to REWORK, which then could not run `git merge` either → deadlock
  needing a manual PM merge-assist). The claude adapter now injects
  `--allowedTools` with the protocol's git command set
  (`GARELIER_GIT_ALLOWED_TOOLS`: read-only inspection + `checkout` / `merge` /
  `add` / `commit` / `restore` / `mv` / `rm` / `stash` / `cherry-pick`),
  additive to the project allowlist, so conflict resolution works independent of
  the fragile per-project allowlist. Deliberately EXCLUDES `git push` (local-only;
  Concierge owns external pushes) and `git rebase` (merge-never-rebase). Dock
  §8.1.B clarified: a merge-gate `conflict` is resolved by Dock, **not**
  reflexively bounced to the Worker. *(impl + spec)*

- **Status Web Console surfaces "PM action needed".** A watcher could not SEE
  when work was stuck awaiting a PM decision without reading runtime files. The
  status snapshot now computes `pmAction`: roles in BLOCKED state or with a
  `questions.md` (the hard "needs a PM/Dock answer" signal), plus the
  Dock→PM inbox review queue (count + most-recent items). The Status page
  shows a **PM action** card (red `N needed` / green `clear`) and, when stuck, a
  red banner + a click-to-open table of the blocked agents / open questions /
  recent escalations. *(impl)*

- **Guardian secret scanner documented as a prerequisite.** The default
  `[guardian_tools] secret_scan` (gitleaks) must be installed + on PATH (and, in
  driver / autonomous mode, in the Guardian role allowlist as `Bash(<tool>:*)`);
  if a mandatory secret / PII scanner is absent the gate cannot PASS and BLOCKs
  (`block_when_required_scanner_unavailable = true`). Reflected the install step
  in `getting_started.md` (prerequisites), `scanner_runbook.md`,
  `setup_config.toml` `[guardian_tools]`, and Guardian SKILL §6, and noted that
  `gitleaks detect` is deprecated since 8.19 (modern: `gitleaks dir` / `git`). *(spec)*

- **Worktree `checkout/` nesting (DEC-020).** Each worktree role's git
  worktree moved from the role directory itself into a `checkout/` subdir, so
  the coordination files (`STATE.md`, `assignment.md`, `report.md`, …) now sit
  in the role *container* beside — not inside — the worktree. This removes the
  generic root-anchored `/STATE.md` … `/archive/` rules the gitignore fragment
  used to inject into the *target's* `.gitignore` (which could silently ignore
  a target's own files), and ends the role-vs-target `CLAUDE.md` collision. The
  provider/human cwd is now the `checkout/`; role `CLAUDE.md` relative paths
  gained one `../` level (and the long-standing Artisan depth bug is fixed in
  passing). Driver: `RoleContext` splits `worktreeDir` (the checkout, provider
  cwd + git ops) from `workerOrScoutCwd` (the container, coordination I/O). The
  setup wizards create the new layout for fresh/diff and gained a **migrate**
  path that nests an existing install's worktrees (idle-gated, idempotent,
  both shells); `doctor` flags a pre-DEC-020 container (no `checkout/`) as P1.
  PM and Dock are unaffected (they are not worktrees).

- **Read-only role named ephemeral branches (DEC-021).** Scout and Observer
  leave detached HEAD for **named throwaway branches** — `spyglass/#<id>/<slug>`
  (Scout) and `monocle/#<id>/<slug>` (Observer) — cut from the studio / review
  tip at pickup and deleted on return to IDLE. The named branch makes the
  snapshot explicit and traceable, stays put while studio advances, and never
  blocks other roles; it is never committed to and never pushed. A per-role
  `checkout` flag (default true) lets a read-only role run **without a
  worktree** (`git show`/`git grep` at a fixed SHA) when a full checkout is
  overkill. The no-commit / no-merge core of DEC-008 / DEC-019 is unchanged.
  `checkout = false` is currently a `setup_config.toml` edit (the driver and
  `doctor` honor it); full wizard automation is deferred.

- **Single-source version (2.5.0).** Added a top-level `VERSION` file and
  unified every skill heading, `docs/` status line, `protocol.md`,
  `state_machine.md`, the setup wizards, and the config template on
  `2.5.0`, so agents never act on a stale spec version. Historical version
  mentions in DECs / CHANGELOG / roadmap are kept as-is.

- **Quality gate is stack-driven, not Rust-assuming.** `[quality_gate]`
  gained a `stack` key (`rust` / `typescript` / `python` / `go` / `mixed`
  / `custom`). The driver resolves commands from the stack's default set
  when none are listed (explicit `commands` win); `stack = custom`/`mixed`
  with no commands is a hard error. The wizards accept `--stack` /
  `-Stack` and repeatable `--quality-gate` / `-QualityGate`, and refuse to
  finish a `custom`/`mixed` setup with no commands. Garelier now targets
  any large app, not just Rust workspaces.

- **Permission profiles (`[permissions]`).** A `profile` of `safe` /
  `reviewed` / `dangerous` controls how much autonomy the provider CLI
  gets: `dangerous` is the old always-full-access behavior (Claude
  `--dangerously-skip-permissions` / Codex `--sandbox danger-full-access`)
  and is now an explicit opt-in; default `reviewed` maps to Claude
  `--permission-mode acceptEdits` / Codex `--sandbox workspace-write`;
  `safe` is inspection-only. Plus `require_pm_approval_paths` /
  `forbidden_paths`. The wizards accept `--permission-profile` /
  `-PermissionProfile` (default `reviewed`, never `dangerous`) and warn on
  `dangerous`. **Note:** existing installs with no `[permissions]` block
  now default to `reviewed` — long unattended autonomous runs that relied
  on full access must set `profile = "dangerous"` explicitly.

- **Completion judgment hardening (Worker + Dock).** Worker now runs
  a **Completion Coverage Audit** (garelier-worker §6.6) after the
  quality gate and before REPORTING — verifying Goal, every Do item,
  acceptance criteria, blueprint functional + non-functional requirements,
  out-of-scope, inputs, and extra touched files, with evidence — and
  records it in `report.md`. Dock runs a matching **Assignment
  Coverage Review** (garelier-dock §7.1.1) before the merge gate; a
  coverage shortfall (a dropped Do item or missed requirement, even when
  tests pass) is a Fail that writes `review.md` (new "Missing required
  content" section) and returns the Worker to REWORK. The Smith review
  references the same coverage check. This closes the "tests passed but
  part of the request was dropped" gap.

- **Lightweight PM / Dock skill entrypoints (DEC-016).** The PM
  and Dock `SKILL.md` files now contain activation metadata,
  pre-flight rules, role boundaries, critical invariants, and reference
  routing tables only. Detailed procedures moved into role-local
  `references/` files with legacy section numbers preserved, and driver
  prompts / operational templates now point Codex-compatible execution
  at the specific reference paths needed for each role path.

- **Detached Worker / Scout / Smith driver leases (DEC-015).** The Bun
  driver no longer waits for long agent turns inside the main poll
  cycle. Worker, Scout, and Smith iterations launch through a detached
  `agent_child.ts` process and record a JSON lease at
  `runtime/driver/pids/<role>-<id>.pid` containing `pid`,
  `assignment_hash`, `branch`, and `started_at`. A restarted driver
  skips live leases, consumes finished leases, and clears stale dead
  leases while invalidating the role's mtime snapshot for retry. This
  makes the earlier status/docs pidfile contract real and prevents long
  agent turns from blocking PM / Dock polls. `status.{sh,ps1}`
  now parse both legacy numeric pid files and the new JSON leases.

- **Operational scenario validation.** Added a 17-scenario validation
  matrix covering normal code work, rework, parallel Workers, GUI-test
  exclusivity, Scout inspections, guarded data-changing tasks,
  Smith/Anvil hardening, delegated requests, scheduled jobs, promote
  readiness, idle driver behavior, multi-PM operation, and irregular
  stop recovery. The validation also tightened the merge-gate
  subprocess contract: both bash and PowerShell scripts archive only
  the request file and leave result/log files visible for Dock,
  bash quality-gate command failures are classified as `failed` instead
  of trap-driven `aborted`, and pre-merge target tracking now reads setup
  config from the request's own PM tree.

- **Driver wait-state token guard.** The Bun driver now persists its
  mtime change tracker under `runtime/driver/change_tracker.json`, so
  restarting an unchanged idle PM tree does not force no-op provider
  calls. Worker/Smith `REPORTING`, `REVIEWING`, and `BLOCKED` states,
  and Scout `REPORTING` / `BLOCKED`, are treated as marker-waiting
  states; the driver wakes them only when review/merge/answer/commit or
  abort marker files appear. Rate-limit outcomes now invalidate the
  tracker so the next post-backoff poll retries the same work instead of
  silently skipping it forever.

- **Smith role and Anvil branches (DEC-014).** Added a post-merge
  hardening role between Worker merge and promote readiness. Smiths live
  under `__garelier/<pm_id>/_smiths/<id>/`, receive task-scoped
  assignments from Dock, create
  `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>` branches from
  studio, and report back for Dock review and merge. Dock now
  dispatches Smith after manual conflict resolution, when Worker tests
  miss integration/system/release boundaries, or when PM/user requests
  target-project spec consistency or license/security checks. Setup
  wizard, driver config, prompts, manifest templates, protocol docs, and
  status helpers now support optional `[[smiths]]` blocks. The configured
  Smith count is the concurrency cap; active Smith work does not stop
  Worker dispatch or Worker merges. Dock coalesces Worker merges
  that land while Smiths are busy into the next Smith hardening batch.
  Smith batch target lists now use parseable `#task@sha` tokens so
  `status.{sh,ps1}` can show pending, active, and total remaining Smith
  hardening targets; promote checks require that count to be zero or
  explicitly waived by the user.

- **Provider-configured driver runners (DEC-013).** The Bun driver no
  longer assumes `claude -p` for every role. `_pm/setup_config.toml`
  now supports `[runner]` plus per-agent `provider`, `model`, and
  `effort` fields. Supported providers are `claude-code` (`claude -p`)
  and `codex-cli` (`codex exec`), and one PM/Dock/Worker/Scout/Smith
  pool may mix both. Codex prompts list required Garelier skill docs
  explicitly because Codex CLI does not auto-load Claude Code skills.
  Provider/model/effort are read at driver start; changing them requires
  driver restart.

- **Retire-and-requeue active agents without `aborted` (DEC-012).**
  PM now has a distinct workflow for removing or replacing non-IDLE
  Workers/Scouts/Smiths while returning their task from
  `runtime/backlog/in_flight.md` to `runtime/backlog/pending.md`.
  The task id is preserved, `next_id` is not incremented, history
  outcome is `requeued`, and no `abort.md` / `ABORTED` state is used.
  Setup wizard diff mode still refuses non-IDLE removals by default;
  PM can pass `--allow-requeued-removal` / `-AllowRequeuedRemoval`
  only after completing the requeue audit.

- **Pre-flight cleanup audit before driver start (PM SKILL §13.4).**
  When the user asks PM to start the driver (Mode B Hybrid path:
  "driver 起動して" / "進めて" / "再開"), PM now runs a 5-step
  audit BEFORE invoking `start_driver.{sh,ps1}`:
  1. Driver / process residue — stale `driver.pid` with dead pid,
     orphan `stop` file. Auto-remove.
  2. Merge gate residue — dead-pid `active.lock`, orphan
     `results/*.json` (left for new driver's first Dock iter
     to consume). Auto-remove the lock; leave results.
  3. Partial merge state — `.git/MERGE_HEAD` present means previous
     driver was killed mid-`git merge --no-ff --no-commit`.
     Auto-run `git merge --abort` to clean.
  4. Primary checkout dirty state — categorize each `M` / `??`
     into PM-owned / Worker-leak / Garelier-meta / unknown.
     Auto-revert Worker leak (confirmed by `git diff <workbench>`
     empty); ask user for PM-owned / unknown items.
  5. Worktree HEAD drift — note stale tips; self-corrects on next
     role iteration per Worker/Scout SKILL §9.1/§3 cleanup steps.

  Cross-referenced from §15.5 (Mode A) and §15.8 (Mode B Hybrid)
  driver-start instructions. The audit takes under a minute and
  prevents whole classes of "driver started but everything is
  stuck" debugging (real incidents documented in §13.4.4).

- **Blueprint `paused` state (DEC-011).** New `## Identity`
  `Status:` value alongside `draft / active / shipped / archived`.
  A `paused` blueprint is skipped by Dock's dispatch scan
  identically to `draft` / `archived`. **Pause is queue-only**: an
  already-dispatched Worker iteration is **not** aborted; the merge
  gate proceeds; the studio merge lands normally. The pause only
  blocks future dispatches of that blueprint. Operator workflow:
  flip selected blueprints `active → paused`, wait for in-flight
  to drain (Workers naturally go IDLE), do release / roadmap work,
  flip back `paused → active` to resume. Audit trail = blueprint
  git history (PM commits the status edit). For aborting an
  in-flight Worker the operator uses PM §13.2 clean-stop —
  pause is a distinct mechanism. Files:
  `garelier-pm/templates/blueprint.md` (status enum),
  `garelier-core/protocol.md §1.8` (lifecycle states + transitions),
  `garelier-dock/SKILL.md §4.0.1` (skip non-active + optional
  `## Paused` section in pending.md),
  `garelier-pm/SKILL.md §4.4` (drain-mode workflow).

- **Blueprint pickup priority (DEC-010).** Each blueprint may carry
  an optional `Priority:` field in its `## Identity` section, with
  four levels: `critical / high / normal / low` (default `normal`).
  Dock's dispatch sort is now
  `(priority_rank, milestone_phase_order, task_id_numeric)` so a
  `critical` blueprint from a later milestone jumps ahead of
  `normal` work in the current milestone. **Insert-only**: a higher
  priority does NOT preempt a Worker already mid-task; it jumps the
  queue and is picked up by the next IDLE Worker. For interrupt the
  user still uses PM §13.2 clean-stop. Priority is an explicit PM
  edit to the blueprint file (audit trail = blueprint git history);
  no automatic age/retry promotion. Files:
  `garelier-pm/templates/blueprint.md` (Priority field added to
  Identity), `garelier-core/protocol.md §1.7` (concept + sort key),
  `garelier-dock/SKILL.md §4.0` (dispatch sort + insert-only
  rule + `pending.md` `[P0/P1/P2/P3]` shorthand display).

- **Retention for high-volume operations (DEC-009).** Added
  `retention.md` to garelier-core and the mirrored human doc under
  `docs/`. PM history now has a hot-index + monthly archive policy,
  high-volume inspections use `category/YYYY/MM/YYYY-MM-DD-topic.md`,
  runtime archives get explicit keep-days / keep-files defaults, and
  raw dumps / full logs are excluded from committed inspection artifacts.

- **Scout inspection PM intake (DEC-008).** Scout now explicitly
  produces an inspection draft, not a self-committed deliverable.
  Dock validates the draft and hands accepted inspections to PM via
  `runtime/pm/inbox/`; PM copies/compares the accepted content in the
  primary checkout, commits (or verifies an existing identical commit),
  then notifies Dock. Scout `REPORTING` therefore means
  "submitted, awaiting review and PM commit/verification" until
  Dock reconciles manifest/backlog.

- **Per-role prompt compression.** `driver/src/prompts.ts` shrunk:
  the GARELIER-* skill is loaded separately by Claude Code at
  activation, so the driver-injected prompt no longer restates the
  step-by-step flow already in SKILL.md. PM / Dock / Worker /
  Scout prompts each lose ~50% of their lines; the headless directive
  also drops boilerplate. Worker keeps its commit-discipline +
  STATE.md-format reminders because they're load-bearing. Net: each
  iteration sends fewer prompt bytes (cache-warm cost rounds to
  zero, cache-cold first iteration noticeably faster).

- **STATE.md format enforced in role SKILLs.** `garelier-worker`
  §5.3 and `garelier-scout` §4.3 now explicitly require canonical
  `## Status` / `## Current branch` / `## Current task` /
  `## Last activity` headers from `templates/state.md` and forbid
  the list-item form (`- Current state: ...`). Real-world Worker
  output had drifted to the list-item form, which made
  `status.{ps1,sh}` parser fall back to aliases. The fallback was
  added defensively (see prior commit) but the canonical form is
  now mandated up front.

- **Async merge gate (v2.2, DEC-007).** The merge gate's expensive
  mechanical work (`git merge --no-ff --no-commit <workbench>` +
  the post-merge quality gate: `cargo test`, clippy, release build)
  moves out of Dock's LLM iteration into a **background
  subprocess** (`skills/garelier-core/scripts/merge-gate.{sh,ps1}`)
  spawned by the driver. Dock's iteration drops from 30–60 min
  (merge-dominated, $3–5 per iter) to 1–3 min (dispatch + verify
  only, $0.5–1). Workers and Scouts no longer stall while a merge
  is in flight — throughput now scales with Worker count instead
  of being gated by Dock. The subprocess uses zero LLM tokens.

  Protocol files at `__garelier/<pm_id>/runtime/merge_gate/{requests,
  results,logs,locks,archive}/`. Driver enforces single-active per
  PM via `locks/active.lock` (pid + request_id); on driver crash
  recovery a stale lock with dead pid is treated as `aborted`.

  Dock SKILL §8.1 split into:
  - **§8.1.A Dispatch** — write `runtime/merge_gate/requests/<seq>-<slug>.json`,
    update manifest to `MERGING`. LLM does not run git itself.
  - **§8.1.B Resolve result** — read `results/<seq>-*.json`:
    `success` → write `merged.md` + manifest update +
    spot-check diff vs. report.md; `failed` → write `review.md` +
    REWORK; `conflict` → Dock resolves manually (the only
    path where Dock runs `git merge` itself, per DEC-001
    §2.5); `aborted` → log + no auto-retry.

  Post-merge **concerns** (merge succeeded technically but
  spot-check found inconsistency) escalate to PM via
  `runtime/pm/inbox/<ts>-merge-concern-<task_id>.md`. PM resolves
  with notes / follow-up dispatch / (rare) `git revert`. Worker
  still transitions to MERGED + IDLE — concerns are project-level
  follow-ups, not Worker REWORK signals.

  `setup_config.toml` gains `[quality_gate] commands = [...]` +
  `timeout_minutes_per_cmd`. setup_wizard creates the runtime
  directory skeleton on fresh init. AGENTS.md prose stays for
  human reference but machine source of truth is the config.

  Files: `scripts/merge-gate.{sh,ps1}`, `driver/src/merge_gate.ts` (new),
  `driver/src/main.ts` (poll integration),
  `driver/src/config.ts` (`QualityGateConfig` interface),
  `garelier-dock/SKILL.md` §8.1 (rewrite),
  `setup_wizard.{sh,ps1}` (config block + dir creation).

- **Per-PM isolation namespace (v2.1, DEC-006).** Breaking change
  from v2.0.x. Every PM now has a short identifier (`<pm_id>`, e.g.
  `acme`) and owns a fully self-contained Garelier environment at
  `__garelier/<pm_id>/`. The top-level shared `__garelier/control/`
  is **eliminated** — there is no shared Garelier state between PMs.
  Multiple developers can drive the same target project from their
  own clones without colliding on tracked paths, task ids, or branch
  names. Branch names also gain a `<pm_id>` segment:
  `garelier/<target-slug>/<pm_id>/{studio,workbench/#<N>/<slug>}`.
  Cross-PM coordination, when needed, uses the existing
  `request_intake/` mechanism.

  **Project-wide planning lives outside Garelier.** If a team wants
  a single source of truth for "what is this project building", the
  convention is to keep it in `docs/project_dashboard/` (the
  project's normal docs tree). Garelier does NOT mandate a format
  and does NOT auto-read it; PMs consult it via normal user
  conversation and carve their personal slice into their own
  `__garelier/<pm_id>/control/blueprints/`. This also makes
  `docs/project_dashboard/` a universal handoff point — single-shot
  AI tools (codex, claude code) write there too, and a later
  Garelier PM picks up context by being told "状況を見て".

  Files updated:
  - Spec: `skills/garelier-core/protocol.md` (§1 layout, §1.5
    project-wide planning, §1.6 task ids, §2 ownership matrix, §6
    persistence, §6.5 branch push, §9 glossary).
  - Spec mirror: `docs/protocol.md` (§1, §1.5, §2, §4, §5).
  - Narrative: `docs/concepts.md` (per-PM isolation paragraph,
    docs/project_dashboard/ convention).
  - Repo guide: `CLAUDE.md` (directory layout, version history).
  - All 4 role SKILL.md (PM, Dock, Worker, Scout) — every
    `__garelier/_*/` and `garelier/<slug>/studio` path gained
    `<pm_id>/`. Worker/Scout project-root relative path corrected
    to `../../../../` (one extra `..` due to new depth).
  - All templates (`agents.md`, `state.md`, `manifest.md`,
    `assignment.md`, `report.md`, `inspection.md`, `blueprint.md`,
    `roadmap.md`, `milestone.md`, `promote.md`, `phase_breakdown.md`,
    `review.md`, etc.) — path refs updated.
  - control_scaffold templates (request_intake, delegation,
    scheduled_jobs) — path refs updated.
  - state_machine.md, compact_handoff.md — path refs updated.

- **Driver gains `pm_id` config.** The autonomous driver
  (`skills/garelier-core/driver/`) reads its PM identity from one
  of: `--pm-id` flag, `GARELIER_PM_ID` env var, or cwd inference
  (`__garelier/<pm_id>/...` ancestor). The driver then operates on
  paths under `__garelier/<pm_id>/...` exclusively. `SetupConfig`
  gains a `pmId` field; `validatePmId()` enforces DEC-006 §2.6
  regex. Driver still does not compute branch names — those come
  from `config.branches.integration` written by `setup_wizard`.
  ~+105 lines across `config.ts`, `main.ts`, `prompts.ts`, `role.ts`,
  `state.ts`. `bunx tsc --noEmit` clean.

- **Helper scripts are multi-PM aware.** `status.{sh,ps1}`,
  `start_driver.{sh,ps1}`, `stop_driver.{sh,ps1}`,
  `scheduler_adapter.{sh,ps1}`, `request_intake_handler.{sh,ps1}`
  all take an optional `--pm-id`/`-PmId` argument with the rule:
  auto-detect when exactly one PM exists, error helpfully when
  multiple require disambiguation, error "No Garelier PM
  initialized; run setup_wizard." when zero. `status` without
  `--pm-id` emits one section per PM (`=== PM: <id> ===`).
  `start_driver` forwards `--pm-id` and `GARELIER_PM_ID` to the
  Bun driver. `request_intake_handler` uses `--target-pm` to route
  control reads and runtime writes to the correct PM's tree and
  validates that the branch's target segment matches.
  `scheduler_adapter` embeds `pm_id` in run.toml / lock.toml /
  inbox notes. ~+486 lines across 10 script files. `bash -n` + PS
  parser checks clean; zero flat path references remain.

- **Setup wizard adds fresh/diff/migrate modes for v2.1.**
  `setup_wizard.{sh,ps1}` (both at parity) now run from
  `__garelier/` (one level higher than v2.0), prompt for `pm_id`
  with default derived from `git config user.name` (sanitized) or
  `$USER`/`$env:USERNAME`, and create `__garelier/<pm_id>/{_pm,
  _dock,control,runtime,_workers,_scouts}/`. Branches are
  generated as `garelier/<target-slug>/<pm_id>/{studio,workbench/...}`.
  Generated AGENTS.md substitutes `{{pm_id}}`. Worker/Scout
  `CLAUDE.md` includes a `PM identifier:` line; project-root
  reference is `../../../../` (one extra `..` for the new depth).
  Diff mode is run from `__garelier/<pm_id>/_pm/` and auto-detects
  `pm_id` from cwd. **Migrate mode is new**: detects flat v2.0
  layout, prompts `pm_id`, runs `git mv` for tracked dirs,
  `git worktree move` per worker/scout, plain `mv` for `runtime/`,
  `git branch -m` for studio and each workbench, patches
  `setup_config.toml` (adds `[pm]` section, rewrites branch refs
  and worktree paths), rewrites `.gitignore` to glob form. Never
  pushes. Versions bumped to `2.1.0` in generated config /
  manifest / next-steps message. `runtime_gitignore` template
  rewritten to glob form (`__garelier/*/runtime/` etc.); v1.x
  `__garelier/workspace/` legacy entry dropped (clean cutover).
  ~+2160 lines across `setup_wizard.{sh,ps1}` +
  `runtime_gitignore` + `docs/setup_wizard_parity_checklist.md`.
  Both wizards pass `bash -n` / PowerShell parse checks; parity
  verified on path templates and CLI flags.

- **Fix: PM bootstrap no longer leaks an auto-derived pm_id.**
  When `garelier-pm` activated on a fresh project (no
  `__garelier/` yet), PM ran `setup_wizard.{sh,ps1}` without passing
  `--pm-id`. The wizard then silently derived a default from
  `git config user.name` (or `$USER`) and used it — which is the
  operator's personal identity leaking into project paths and branch
  names without confirmation. Two-part fix:
  1. **PM SKILL §3.1** now lists `pm_id` as parameter #1 and the
     PM must ask the user via `AskUserQuestion`. SKILL §3.3
     enforces `--pm-id "$PM_ID"` / `-PmId $PmId` in the wizard
     invocation — never omit it.
  2. **`setup_wizard.{sh,ps1}` non-TTY guard**: if `--pm-id` /
     `-PmId` is not provided AND stdin is not a terminal (i.e.,
     the script is being driven by an AI agent / driver / CI),
     the wizard refuses to derive a default and exits 2 with a
     message telling the caller to re-run with `--pm-id <slug>
     explicitly chosen by the user`. The suggested default is
     printed as advisory only.
- **`pm_id` format allows underscores.** Spec is
  `[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?` — lowercase ASCII + digits
  with internal hyphens **or underscores**. Both are git-ref-safe;
  the choice is a slug-readability preference. Recorded in DEC
  0006 §2.6, `protocol.md` §9, and `docs/protocol.md` §4.

- **Garelier branches are local-only** (`garelier-core/protocol.md`
  §6.5 new). `garelier/<target-slug>/studio` and every
  `garelier/<target-slug>/workbench/#<id>/<slug>` MUST NOT be pushed
  to any remote. Previously the role skills instructed `git push` at
  five points (PM bootstrap, Worker rebase, Worker REPORTING,
  Dock merge, Dock cleanup) — all removed. The only
  Garelier operation that pushes to a remote is PM's promote-time
  `git push origin <target> --tags`. Rationale: these branches encode
  one developer's machine-local coordination state; pushing them
  prevents a second developer from running Garelier on the same
  project (studio name collision, workbench id clash). Worker→
  Dock hand-off works without push because the workbench
  worktree and the primary checkout share the same `.git/`, so
  Dock reads workbench refs directly from local. Files touched:
  `garelier-pm/SKILL.md` §3.5, `garelier-pm/scripts/setup_wizard.{sh,ps1}`,
  `garelier-worker/SKILL.md` §6.5.4 + §7.2,
  `garelier-dock/SKILL.md` §8.1 step 4 + step 7,
  `garelier-core/templates/agents.md` §4, and the new
  `garelier-core/protocol.md` §6.5 (mirrored in `docs/protocol.md`).
- **Driver rebuilt from scratch in TypeScript + Bun**, spawning
  `claude -p` as a subprocess per role iteration. Single
  cross-platform implementation at `skills/garelier-core/driver/`.
  - **Works with your existing Claude Code login** —
    authentication is whatever `claude login` set up
    (~/.claude/.credentials.json); no separate `ANTHROPIC_API_KEY`
    needed.
  - `Bun.spawn` passes the argv array straight to the OS — no
    PowerShell `Start-Process -ArgumentList` re-tokenization, no
    cwd mismatch, no Job-Object inheritance fights. The nine
    failure modes the previous shell driver collected cannot
    recur in this layer.
  - mtime-based pre-check: a role's `claude -p` is only spawned
    when something it would actually consult has changed since the
    last iteration. Idle projects effectively cost nothing per
    poll.
  - Structured JSONL logs per role under
    `__garelier/runtime/driver/logs/`. Driver records each
    iteration's cost / token counts / exit code / one-line result.
  - PID atomic claim (`openSync(..., "wx")`) prevents double-start.
    Graceful shutdown via stop file, SIGINT/SIGTERM, or the
    existing SessionEnd hook in `_pm/.claude/settings.json`.
- **Three documented run modes (PM SKILL.md §15.9 comparison
  table):**
  - **Mode A: Full driver** (`supervise_pm = true`) — driver
    supervises PM + Dock + Workers + Scouts. Unattended.
  - **Mode B: Hybrid** (`supervise_pm = false`) — driver supervises
    Dock + Workers + Scouts; user keeps an interactive PM.
  - **Mode C: Interactive + /loop** — no driver, no Bun. User
    opens one `claude` session per role and uses `/loop <interval>`
    on the non-PM ones for auto-polling. Best for live observation,
    debugging, or users who don't want the
    Bun toolchain. PM SKILL.md §15.10 gives the prompts to paste.
- **`start_driver.{sh,ps1}` and `stop_driver.{sh,ps1}` restored**
  as thin wrappers around the Bun driver. Detached spawn via
  `Start-Process -WindowStyle Hidden` (Windows) / `setsid` or
  `nohup` (Unix), so PM can call them via its Bash tool without
  the lifetime issues we hit before. Stop is just `touch stop_file`
  under the hood.
- Driver requirements: Bun 1.1+, `claude` CLI authenticated
  (`claude login`), `ripgrep` on PATH (for Claude's Grep tool).
  No Python, no API key.
- **Iteration timeout bumped to 6 hours** (was 2h → 30 min → 10 min
  before that). Real Rust implementation iterations on this codebase
  (`cargo check` 3-5 min, `cargo test` 5-15 min) plus chained
  follow-ups (clippy gate, release build, fmt audit, cross-crate
  refactor cleanup) can legitimately run an hour or more, and
  Dock merge-gate iterations that re-run the same quality gates
  on `studio` after a `git merge --no-ff --no-commit` reach 45 min
  in real-world testing. The timeout is positioned as a **stuckness
  detector**, not a deadline for honest work — the only thing that
  should trigger it is a genuinely hung iteration (network deadlock,
  infinite loop, model wedged on a tool call).
- **Worker prompt enforces commit discipline.** Before any new edit,
  the Worker runs `git status` + `git diff --stat` to find
  uncommitted work from a previous interrupted iteration and resumes
  from there rather than redoing it. After every cohesive sub-step
  (one function, one compile-clean checkpoint), the Worker commits
  immediately — WIP commits explicitly encouraged. Caught in real
  testing: both Workers were producing substantial Rust code
  (244 / 152 lines) but never reaching `git commit` before the
  previous 30-min timeout, leaving the workbench branch empty and
  every retry restarting from scratch.
- **Driver passes `--dangerously-skip-permissions`** (note: no
  `allow-` prefix) to each spawned `claude -p`. `claude --help` has
  two similarly-named flags: `--allow-dangerously-skip-permissions`
  only *enables bypassing as an option* (requires a UI to actually
  flip it), while `--dangerously-skip-permissions` actually bypasses
  every permission check. In `-p` headless mode the "allow-" variant
  is a no-op and every Write/Edit/Bash call still gets denied — caught
  in real testing as a 7-minute Dock iteration that completed
  its reasoning ($2.50, 45 turns) but exited with "no action: Write
  tool denied". Documented as a hazard in `role.ts`.

### Added

- Driver hybrid mode via `[autonomy] supervise_pm` flag (default
  `true`, preserves classic v1.0 behavior). Setting it to `false`
  makes the driver supervise Dock, Workers, and Scouts only —
  the user keeps an interactive PM session in `__garelier/_pm/`.
  Auto-approve flags continue to apply to the interactive PM. Bash
  and PowerShell drivers stay at parity; both log `supervise_pm=...`
  and a hybrid-mode banner at startup. PM SKILL.md §15.4 / §15.7 /
  §15.8 and DEC-002 §4.x document the trade-offs, including the
  `.git/index.lock` race between interactive PM and driver-spawned
  Dock on the shared main checkout.
- `start_driver.{sh,ps1}` / `stop_driver.{sh,ps1}` helpers in
  `garelier-core/scripts/`. PM (under hybrid mode `supervise_pm =
  false`) calls these via its Bash tool to manage the driver
  lifecycle conversationally:
  - `start_driver` spawns the driver **detached** (`setsid` / `nohup`
    on Unix, `Start-Process -WindowStyle Hidden` on Windows) so PM's
    Bash subprocess can return immediately and the driver outlives
    that subprocess. Refuses to start if `driver.pid` shows a live
    driver. Without the detach, PM-spawned drivers were dying within
    ~90s as soon as PM moved on to the next user turn.
  - `stop_driver` writes the stop file and returns immediately, with
    `--wait` / `-Wait` to block until the driver actually exits.
    Equivalent to the SessionEnd hook's behavior but invocable
    mid-session without `/quit`-ing PM.
  - PM SKILL.md §15.5 and §15.8 are updated to permit PM to spawn
    the driver via these helpers in hybrid mode (was previously
    forbidden outright — a holdover from full-driver-mode design).
    Direct `driver.{sh,ps1}` invocation via PM's Bash tool is still
    forbidden because of the subprocess-lifetime trap.
- `status.{sh,ps1}` gained `--project <path>` / `-ProjectRoot <path>`
  parameter, defaulting to current working directory. Lets a single
  terminal monitor multiple Garelier projects in parallel (one
  process per project — each project's `__garelier/runtime/` state
  is local, so concurrent drivers on different projects do not
  interfere). The output now includes a `Root:` line so the user can
  tell which project a snapshot belongs to. Brings the helper to
  parity with `start_driver` / `stop_driver`, which already accepted
  a project-root argument.
- `status.{sh,ps1}` one-shot project-state inspector at
  `skills/garelier-core/scripts/`. Reads `setup_config.toml`,
  `driver/driver.pid`, `driver/pids/*.pid`, per-role `STATE.md`,
  `runtime/manifest.md`, and `driver/logs/driver.log` to produce a
  human-readable snapshot (mode, branches, driver liveness, currently
  spawning iterations, Worker/Scout states with current task and last
  activity, backlog counts, active milestones, open escalations,
  recent activity, and the last 8 lines of `driver.log`). Pass
  `--watch <seconds>` / `-Watch <seconds>` to refresh in place.
  Surfaces stale `driver.pid` (kill -9 / crash / power loss) as
  "STALE pid file" so the user notices zombies. PM SKILL.md §15.6.1
  documents the helper. Bash and PowerShell versions stay at parity.
- Driver now passes `--add-dir <project-root> --add-dir <garelier-core>`
  when spawning each role's `claude -p`. Without this, the spawned
  session is sandboxed to its own role cwd and cannot read sibling
  files (`runtime/manifest.md`, `control/blueprints/*`,
  `_workers/*/STATE.md`, `_pm/setup_config.toml`, project-root
  `AGENTS.md`, or the garelier-core skill protocol/templates), which
  was causing Dock/Worker/Scout iterations to noop-exit with
  "permission denied" complaints in their logs while the user saw
  the driver "running" but nothing happening. Override the skill-core
  path with `GARELIER_CORE_DIR` env var if needed.
  - Driver computes all internal paths as ABSOLUTE
    (`PROJECT_ROOT="$(pwd -P)"` on bash, `$ProjectRoot = (Get-Location).Path`
    on PowerShell, prepended to every derived path). The driver
    `cd`s into each role's worktree before spawning `claude -p`, so
    any path passed via `--add-dir`, `--append-system-prompt-file`,
    or stdin redirect must be absolute — otherwise it gets
    re-resolved against the role's worktree cwd, producing nonsense
    like `.../_dock/__garelier/runtime/driver/tmp/...` and
    "file not found" errors (observed: `Append system prompt file
    not found` in dock.log.err with a doubled `__garelier`
    segment).
  - Driver passes the headless override directive via
    `--append-system-prompt-file <path>` (file under
    `__garelier/runtime/driver/tmp/headless_override.txt`) and the
    per-role iteration prompt via stdin redirect, NOT as long
    `--append-system-prompt <string>` and positional argv. Reason:
    PowerShell `Start-Process -ArgumentList` re-tokenizes long
    quoted string values; one symptom observed was the Dock
    receiving just the word "are" because PowerShell split the
    directive on whitespace and claude consumed the fragments as
    separate args, leaving only one short word as the user message.
    File-based passing puts only short paths in argv, sidestepping
    the issue on both shells.
  - Driver also passes `--append-system-prompt <headless directive>`
    to counter project-level plugins (e.g. `terse-plugin`'s terse
    "原始人モード") that would otherwise instruct the spawned
    `claude -p` to reply in compressed style or ask the user a
    question instead of executing the iteration. Without this, with
    `terse-plugin@terse-plugin: true` enabled in the project's
    `.claude/settings.json`, Dock was responding with a single
    line ("Dock ready. 何しますか？") and exiting without doing
    any actual dispatch work. The directive tells the role it is
    running headless, must execute the user message literally, must
    not call `AskUserQuestion`, and must exit silently when done.
    The directive text avoids parens and `-`-prefixed tokens because
    `Start-Process -ArgumentList` on Windows re-tokenizes strings
    that contain those, and the spawned claude saw fragments like
    `-p)` and `-).` as unknown options. Plain prose without
    parens / flag-shaped substrings is safe across both shells.
  - Driver also passes `--allow-dangerously-skip-permissions` to each
    spawned `claude -p`. Headless mode has no UI to answer per-tool
    permission prompts, so without this flag every `Write` / `Edit` /
    `Bash` call is silently denied — Dock would correctly plan
    a dispatch, attempt to write `_workers/<id>/assignment.md`, get
    denied, and exit noop. Autonomy is opt-in via
    `[autonomy] enabled = true`, so the user has already consented
    to unattended writes. Override via `GARELIER_SPAWN_CMD` to
    remove the flag (then enumerate `--allowed-tools` patterns).
  - Driver start uses an atomic file-create primitive for the
    double-start guard: bash `set -C; echo $$ > driver.pid` (noclobber),
    PowerShell `[System.IO.File]::Open(..., CreateNew, ...)`. Only one
    process can win at the OS level.
    The PowerShell variant calls
    `[System.IO.Directory]::SetCurrentDirectory((Get-Location).Path)`
    at startup because .NET file APIs use the .NET-process cwd, not
    PowerShell's `$PWD` — without the sync, relative paths
    (`__garelier/runtime/driver/driver.pid`) resolved against the
    wrong directory and the script failed with "You cannot call a
    method on a null-valued expression" on its first PID read.
    The PID read also has a null guard for empty/missing files. Earlier mkdir-based attempt had
    a TOCTOU window where the loser observed the brief gap between
    the winner's `mkdir` and PID write, concluded "stale", deleted
    the lock, and started a second driver — observed in Project-X
    as two simultaneous `Garelier driver starting` log lines and
    competing iteration spawns.
  - Ordering matters: `--add-dir` accepts a variadic value
    (`<directories...>`) and silently consumes any positional that
    follows it, so the spawn command must place `--add-dir` flags
    *before* `-p` and the prompt. The driver splits `$SPAWN_CMD` /
    `$SpawnArgsPre` into binary + flags and injects `--add-dir`
    between them. Putting `--add-dir` after `-p` results in
    "Input must be provided either through stdin or as a prompt
    argument when using --print" and every iteration noop-exits.
- Driver lifecycle coupling for hybrid mode:
  - Driver writes its own PID to `__garelier/runtime/driver/driver.pid`
    on startup and removes it on graceful exit. A second `driver`
    launch refuses to start if the existing PID is alive, and cleans
    up the stale file otherwise.
  - Setup wizard generates `__garelier/_pm/.claude/settings.json`
    containing a `SessionEnd` hook that touches the driver stop file.
    Result: when the user `/quit`s the interactive PM session or
    closes the PM terminal normally, the driver shuts down within one
    poll. The hook is harmless in non-hybrid setups.
  - PM SKILL.md §1 pre-flight step 7 adds a zombie-driver check in
    hybrid mode: `driver.pid` present with a dead PID → cleanup and
    notify user (this catches the rare `kill -9` / power-loss case
    that `SessionEnd` cannot).
- Setup wizard now writes a `[setup] complete = true` completion marker
  to `__garelier/_pm/setup_config.toml` as its very last step. PM
  pre-flight uses this marker (or, for legacy v1.x configs, the
  presence of `[branches]` + manifest + history files) to decide whether
  a project is fully initialized. Bash and PowerShell wizards stay at
  parity.
- Setup wizard fresh mode detects **partial installs** — leftover
  `__garelier/{runtime,control,_pm,_dock,_workers,_scouts}/`
  directories, the studio branch belonging to the partial install, or
  worktrees from an interrupted prior run — and prompts to clean them
  up before retrying fresh init (worktrees removed, studio branch
  deleted, `__garelier/` removed, `.gitignore` block trimmed).
  `--skip-confirm` / `-SkipConfirm` auto-cleans without prompting.
  Cleanup respects the **target-derivation invariant**: the branch to
  switch onto and the studio branch to delete are both resolved from
  the user-chosen target (or the partial install's recorded
  `[branches] target`/`integration`) and are never permitted to be a
  `garelier/*` value. Unrelated `garelier/<other-slug>/studio`
  branches are left untouched.
- PM SKILL.md §3.6 documents the partial-install recovery path; §3.1
  now requires `AskUserQuestion` for every setup parameter (so a
  cancelled-and-restarted wizard never silently re-applies prior
  defaults) and instructs PM to present the *current branch* as the
  first/recommended target option.
- Request intake control scaffold:
  `__garelier/control/request_intake/` defines request branch schema,
  allowed sources/kinds, webhook policy, and request templates for
  PM-handled delegated requests.
- Delegation control scaffold:
  `__garelier/control/delegation/` defines remote PM registry and
  incoming capability registry.
- Scheduled jobs control scaffold:
  `__garelier/control/scheduled_jobs/` defines RRULE-based recurring
  job definitions, plus report/audit paths for scheduled runs and
  external notifications.
- Setup wizard fresh mode now creates matching `control/` and
  `runtime/` directories and copies the new
  `garelier-core/templates/control_scaffold/` files.
- DEC-004 documents the decision to ship request intake and scheduled
  jobs as guarded contracts rather than arbitrary remote execution.
- Reference request intake and scheduled job adapters:
  `skills/garelier-core/scripts/request_intake_handler.{sh,ps1}`
  validates delegated request exports into `runtime/requests/inbox/`,
  and `scheduler_adapter.{sh,ps1}` turns due scheduled jobs into PM
  inbox notifications without executing job bodies.
- Always-on compact handoff:
  `skills/garelier-core/compact_handoff.md` defines concise internal
  role-to-role files for assignments, reports, questions, inbox notes,
  manifest activity, and runtime backlog state.
- DEC-005 documents compact handoff as Garelier-owned behavior rather
  than a dependency on an external style plugin.

### Changed

- `docs/concepts.md` now fills in the v2.0 concept sections for role
  responsibilities, branch/worktree layout, escalation flow, and
  parallel milestone execution.
- `docs/getting_started.md` troubleshooting now covers common setup
  failures with concrete recovery steps: symlink permissions, wrong
  wizard directory, missing initial commit, missing target branch,
  diff-mode exit codes 2/3, stale worktrees, and BLOCKED agent recovery.
- `install.sh` and `install.ps1` now use matching installer status
  prefixes for successful skill links and backup notices.
- Added `docs/setup_wizard_parity_checklist.md` and linked it from the
  framework quality gates so future setup wizard changes have a concrete
  bash/PowerShell parity checklist.
- Added `docs/driver_failure_scenarios.md` and linked it from the
  framework quality gates so driver changes have manual recovery and
  abnormal-stop scenarios to verify.
- PM inbox handling now explicitly classifies Dock escalations,
  delegated requests, and scheduled job notifications.
- PM, Dock, Worker, and Scout skills now apply compact handoff to
  internal state while keeping user-facing replies and public docs normal.
- Core templates for assignments, reports, questions, inbox
  notifications, manifest activity, state, escalation, and status
  summaries now favor compact handoff shapes.
- `docs/protocol.md`, `skills/garelier-core/protocol.md`, README,
  root AGENTS.md, and AGENTS template document the new
  control/runtime paths.

### Decisions

- The framework ships request/schedule contracts, setup scaffolding, and
  local reference adapters, not a universal webhook receiver or scheduler
  runner. Receivers, clocks, signatures, and credentials remain
  target-project operations.
- Compact handoff is always active for internal role-to-role files. It
  has no runtime toggle.

### Fixed (post-review hardening)

- **Producer could silently deadlock at branch-cut; git-capability coverage is now
  a CI-enforced invariant (DEC-048).** `GARELIER_GIT_ALLOWED_TOOLS` granted
  `git checkout`/`git branch` but not `git switch`, while an assignment used the
  modern `git switch -c` idiom — so a Worker/Smith was denied at pickup and never
  reached WORKING (it could commit but not create its branch), surfacing only as a
  stuck live run. Granted `Bash(git switch:*)` (both branch-creation idioms now
  work), and — so this CLASS cannot recur — externalized the allowed/forbidden git
  commands to a Librarian-managed single source of truth,
  `docs/garelier/knowledge/git_command_policy.toml` (seeded by the wizard). A
  driver test (`providers/git_allowlist_coverage.test.ts`) enforces that the driver
  grant **mirrors** the policy's `allowed` set, grants nothing it marks
  `forbidden`, and that no role instruction names a git command outside the policy
  — so granted-vs-required drift fails CI instead of stalling an autonomous run.
- **Status surfaces idle-with-pending (a held/stuck dispatch is now visible).**
  When the driver was up but no producer was working and no gate was running
  while the backlog still had pending items, the status was silently idle — no
  clue WHY the next task wasn't starting (usually an intentional dispatch hold /
  PM directive in `dock/inbox`, sometimes a stuck dispatch). `buildSnapshot`
  now emits an `idle_with_pending` warning naming the pending count and pointing
  to `runtime/dock/inbox/`, so idle-by-design is distinguishable from broken.
  Also fixed `driverAlive` to parse a bare-number `driver.pid`.
- **Status snapshot truthfully reports an in-flight merge gate (no stale
  "failed").** `readMergeGate` reported the newest *completed* result as the
  current state, ignoring a newer request and the runner's `active.lock`. So
  while a re-gate was actively running (e.g. after an environment fix
  superseded an old sccache false-fail), every status surface — the console
  and the SessionStart digest's `failed_quality_gate` warning — still read
  "Latest merge-gate result is failed", which is misleading: the run in flight
  supersedes that result. It now reports `state: "running"` whenever the active
  lock is held or a queued request has no matching result yet, keeps the prior
  outcome in `lastResult` (not as the current state), and suppresses the
  failed-gate warning while a run is in flight (it fires only for a genuinely
  last, non-superseded failure). Covered by new `status_snapshot` tests.
- **Merge-gate reproducible-build hardening — host `RUSTC_WRAPPER` no longer
  false-fails every build.** cargo lets a `RUSTC_WRAPPER` / `RUSTC_WORKSPACE_WRAPPER`
  env var **override** the project's `.cargo/config.toml`. A stray/broken host
  wrapper — e.g. a leftover `RUSTC_WRAPPER=sccache` after a project removed sccache
  from its config, or an sccache that cannot run the C compiler (`Compiler not
  supported: ""`) — therefore poisoned **every** merge-gate build regardless of the
  candidate's source, surfacing as a misleading E0463/E0282 source-defect cascade
  rather than an environment fault. The merge gate now `unset`s both wrappers before
  running quality-gate commands so the gate honors the repo's own wrapper decision
  (a project that genuinely wants a wrapper puts it in `.cargo/config.toml`, which
  cargo still reads). Both `merge-gate.sh` and `merge-gate.ps1` (the Windows path)
  apply it, at feature parity.
- **Compact-handoff discipline tightened (token efficiency).** Rather than
  add a separate message-bus subsystem, the existing compact handoff —
  which already mandates "pointers over pasted context" — now states a hard
  rule: **never paste an artifact body** (diff, full report, blueprint,
  inspection, `result.json`) into a handoff/inbox file; carry the
  conclusion + a `read:` pointer (the official file stays the single source
  of truth). Added a Reading Rule so supervisory readers (PM/Dock) act
  on the conclusion + pointer and open the artifact only when the decision
  needs it. `doctor` gained a P2 `handoff-bloat` check (handoff/inbox files
  over 16 KB usually mean a pasted body). Canonical + `docs/` mirror in sync.
- **Mechanical Observer merge gate (P0-3, DEC-019).** The merge gate now
  enforces Observer review instead of relying only on skill instructions.
  The merge request gained `observer_required` / `observer_verdict` /
  `observer_report_path`; when `observer_required` is true the merge gate
  reads the verdict **from the Observer report** (not a request-supplied
  claim) and refuses the merge (`failed` result) unless it is `PASS` /
  `PASS_WITH_NOTES`. Both `merge-gate.sh` and `merge-gate.ps1` enforce it;
  Dock §7.5/§8.1.A populate the fields.
- **Robust merge-gate JSON parsing (P1-4).** `merge-gate.sh` no longer
  parses the request with grep/sed/awk (which mangled quote-escapes,
  newlines, and special characters in quality-gate commands). It now
  delegates to a Bun helper (`driver/src/merge_gate_parse.ts`, 9 unit
  tests) that `JSON.parse`s the request and emits NUL-delimited records
  read via `mapfile -d ''` — no eval. `merge-gate.ps1` already used native
  `ConvertFrom-Json`.
- **Fresh AGENTS.md is mostly pre-filled (P0-1).** The setup wizards fill
  the §1 language/build/test fields (from `--stack`) and the §2 quality
  gate block (from the resolved commands), leaving only project-specific
  fields (restricted files, conventions). The `doctor` AGENTS.md
  placeholder remediation now says to edit those fields rather than
  "re-run setup_wizard" (which skips an existing AGENTS.md).
- **`protocol.md` documents the v2.5 roles (P0-2).** The canonical and
  human protocol layers now cover `_artisan/` / `_librarians/` /
  `_observers/` / `runtime/observer/` / `control/observations/` /
  `lane.lock`, the shelf/satchel branches, and the new roles' ownership
  rows. The canonical `state_machine.md` gained an Observer section.
- **CLI/status & docs surface the new roles (P1-1/P1-2/P1-3).**
  `status.{sh,ps1}` show Artisan / Librarian / Observer, the active lane,
  and Observer request/result verdicts; the setup-wizard help documents
  `--stack` / `--quality-gate` / `--permission-profile` (and the new role
  flags); `getting_started.md` covers the new roles, flags, doctor, status
  web console, and the required post-setup AGENTS.md edit.

## [2.0.0] - 2026-05-24

Terminology rename and structural split. Strictly renamed over v1.0.0
(no behavior changes). All canonical Garelier names are now
distinct from git-flow.

See DEC-003 (rename to studio / workbench / target + control/runtime).

### Changed (breaking)

- **Vocabulary rename**:
  - `base` → `target` (user-owned final branch)
  - `base-slug` → `target-slug`
  - `develop` → `studio` (Dock integration branch)
  - `feature` → `workbench` (per-Worker branch)
  - `spec` → `blueprint` (PM-authored task specification)
  - `research_report` → `inspection` (Scout deliverable)
  - `release` → `promote` (human-approved studio → target merge)
  - `workspace` → `runtime` (transient execution state)
  - `project_state` → `project_dashboard` (persistent planning state)
  - `track-base.md` → `track-target.md` (Worker base-tracking marker)
- **Branch hierarchy** (slug rule unchanged):
  - `garelier/<base-slug>/develop` → `garelier/<target-slug>/studio`
  - `garelier/<base-slug>/feature/#<id>/<slug>` → `garelier/<target-slug>/workbench/#<id>/<slug>`
- **Directory split**: `__garelier/workspace/` (single root) is split
  into two roots with different lifetimes and git treatment.
  - `__garelier/control/` — persistent project authority (tracked).
    Holds `project_dashboard/`, `operations/`, `blueprints/`,
    `inspections/`, `decisions/`, `reports/`.
  - `__garelier/runtime/` — transient execution state (gitignored).
    Holds `manifest.md`, `backlog/`, `dock/`, `pm/`, `driver/`.
- **Config key rename**: `[autonomy] auto_approve_specs` →
  `[autonomy] auto_approve_blueprints`. Other autonomy keys
  unchanged.
- **Setup wizard** accepts `--target` / `-Target` (and continues to
  accept `--base` / `-Base` as a deprecated alias). Generates the
  new `control/` and `runtime/` trees with seeded README, operations
  rules, and project_dashboard skeletons.
- **PM moves persistent deliverables to `control/`**:
  - `__garelier/_pm/spec/` → `__garelier/control/blueprints/`
  - `__garelier/_pm/roadmap.md` → `__garelier/control/project_dashboard/roadmap.md`
  - Release candidates → `__garelier/control/reports/promote/`
  - `_pm/setup_config.toml` and `_pm/history.md` stay in `_pm/`
    (role-internal state).

### Added

- **`__garelier/control/operations/data_change_policy.md`**: mandatory
  guardrails for any task that mutates external data — dry-run,
  before/after counts, sample records, rollback plan, explicit
  user approval per execution, no secrets. Binding even under
  `[autonomy] enabled = true`. Dock refuses the merge gate
  for any blueprint or report that omits a required guard.
- **`__garelier/control/operations/promote_checklist.md`**:
  enumerated pre-promote checks (clean studio, all workbenches
  merged or abandoned, tests passing, quality gates satisfied,
  risks reviewed, no pending data writes, explicit user approval).
- **`__garelier/control/operations/recovery.md`**: procedures for
  driver crash recovery, marker-file collisions, and
  state-inconsistency reconciliation.
- **`__garelier/control/project_dashboard/`** structured under
  `current.md`, `roadmap.md`, `backlog.md`, `decisions.md`,
  `risks.md`, `quality_gates.md`, `notes.md`. `notes.md` is
  lowest-authority scratch; validated entries promote to the
  appropriate higher-authority file.
- **Root `AGENTS.md`** at the framework repo top level, naming the
  canonical vocabulary and hard rules. New AI agents read this
  first before doing anything in the repo.
- **`history.md` outcome**: `data-change-approval` for the entry
  recording explicit user approval of a data-mutating execution.
- **Worker `Data-change evidence` section** in `report.md` template
  for data-changing tasks (mirrors blueprint's Data-change guards).
- **DEC-003** documenting the rename and structural split.

### Decisions (in addition to DEC)

- **No `auto_promote` flag** and there will not be one. Promotes
  remain user-gated even under full autonomy.
- **`notes.md` is explicitly lowest-authority** in the project
  dashboard. Decisions, quality gates, current status, roadmap,
  and backlog all override it. Validated notes get promoted.
- **Old terms remain in historical DECs and CHANGELOG entries**;
  they are tagged as deprecated. New content uses canonical v2.0
  vocabulary.
- **`runtime/manifest.md` is not a project dashboard.** The project
  dashboard is `__garelier/control/project_dashboard/`. The
  manifest is just the live agent state index. This distinction
  is repeated in every role SKILL.md to prevent drift.

### Migration

None. v1.0 had no production install base. v1.0 → v2.0 cutover is a
mechanical rename plus directory split; users with a v1.0 project
in flight either:
- run the v2.0 setup wizard fresh and re-attach their work, or
- hand-edit using a sed-style substitution per the vocabulary table.

### Removed

- `__garelier/workspace/` (replaced by split into `control/` +
  `runtime/`). The legacy path stays in the gitignore template for
  any leftover migration content.
- Template `workspace_gitignore` (renamed to `runtime_gitignore`).
- Template `research_report.md` (renamed to `inspection.md`).
- Template `release_candidate.md` (renamed to `promote.md`).
- PM template `spec.md` (renamed to `blueprint.md`).

## [1.0.0] - 2026-05-23

Autonomous-mode capability landed. Strictly additive over v0.2.0;
existing projects work unchanged unless they opt in.

See DEC-002 (autonomous mode via per-iteration driver).

### Added

- **`[autonomy]` opt-in block** in `__garelier/_pm/setup_config.toml`
  - master switch `enabled` (default `false` — classic v0.2.0 behavior)
  - `auto_approve_specs` — PM commits spec drafts without user review;
    open questions go into the spec's Open questions section
  - `auto_approve_milestones` — PM creates/updates milestones without
    confirmation
  - `driver_poll_interval_seconds` — how often the driver invokes role
    iterations (default 30s)
- **driver scripts** at `skills/garelier-core/scripts/driver.{sh,ps1}`
  - **Per-iteration spawn model**: every poll, the driver runs
    `claude -p "<role-specific prompt>"` for each role that needs an
    iteration. Each invocation cold-starts, runs one iteration, and
    exits.
  - PM and Dock are invoked every poll; they decide for
    themselves whether there's work and exit quickly if not.
  - Worker and Scout are invoked while their STATE.md reports an
    active state (`ASSIGNED` / `WORKING` / etc.).
  - No in-process session lifecycle (no `/compact`, no `/clear`).
    State is recovered from files on every cold start.
  - Spawn command defaults to `claude -p`; overridable via
    `GARELIER_SPAWN_CMD` env var.
  - Stop signal: touch `__garelier/workspace/driver/stop`.
- **PM SKILL.md §4.4** — autonomous spec drafting from milestones
  (PM picks the next unchecked spec listed in milestones.md and
  drafts it without user input)
- **PM SKILL.md §15** — consolidated autonomous-mode reference
  (`[autonomy]` schema, what PM skips, `autopilot:` tagging,
  per-iteration discipline, enabling/disabling, **§15.7 user input
  channels during autonomous mode**, **§15.8 idle behavior at
  roadmap completion**)
- **Dock SKILL.md §12.5** — per-iteration invocation discipline
  (no internal polling, trust files, exit promptly)
- **Dock SKILL.md §8.5–§8.6** — instructing a Worker to track
  base via `track-base.md`, drift detection
- **Worker SKILL.md §6.5** — feature-side base tracking (merge by
  default, rebase only on explicit instruction)
- **history.md `autopilot:` tag** for unsupervised drafting; auditable
  via `grep "Outcome: autopilot:"`

### Decisions (in addition to DEC)

- **Release flow remains user-instructed** even in autonomous mode.
  No `auto_release` flag in v1.0 (revisit at v2.0 if ever).
- **`<base>` is never modified without user instruction**, boundary
  reinforced in PM SKILL.md §2.
- **Spawn strategy**: per-iteration `claude -p` for every role.
  Originally drafted with long-lived PM/Dock + per-task
  Worker/Scout, revised before release because long-lived sessions
  via interactive `claude` cannot run unattended (they wait for user
  input). Per-iteration matches the file-based persistence model and
  removes the need for any in-process lifecycle management.
- **No `/compact` or `/clear`** in v1.0. Every invocation is cold-start
  short-lived; session lifecycle is "not applicable."
- **Feature-side base tracking uses merge by default**. Rebase is
  allowed only when Dock explicitly approves and no external
  reviewer has inspected the branch.

### Migration

None. v1.0 is additive over v0.2.0. Existing projects keep working;
no config change required unless the user wants to enable autonomous
mode.

### Deferred to "future consideration"

The following are not in v1.0 and live in
`__garelier/control/project_dashboard/roadmap.md` §3 (path updated
for v2.0; v1.0 used `docs/project_state/roadmap.md`):

- Selective `__garelier/workspace/` tracking (now superseded by the
  v2.0 control/runtime split)
- Per-spec `preferred_model` (now `preferred_model` per blueprint)
- `_pm/dashboard` view
- `auto_release` flag (now would be `auto_promote`; no plan to add)
- Multi-base 1-repo flow, multi-host driver, reviewer-only role,
  setup wizard dry-run, bilingual policy, doc deduplication

## [0.2.0] - 2026-05-23

Breaking restructure of directory layout and branch naming.
See DEC-001 (restructure to Garelier; remove trunk tier).

### Changed (breaking)

- **Directory restructure**: all Garelier-managed paths now live
  under a single `__garelier/` root in the target project.
  - `_pm/` → `__garelier/_pm/`
  - `_dock/` → `__garelier/_dock/`
  - `_workers/<id>/` → `__garelier/_workers/<id>/`
  - `_scouts/<id>/` → `__garelier/_scouts/<id>/`
  - `.workspace/` → `__garelier/workspace/` (no longer hidden,
    isolated by parent prefix)
- **Branch hierarchy**: user-chosen base, two-tier instead of three.
  - User base (default `main`) is recorded at setup time
  - Integration branch: `garelier/<base-slug>/develop`
    (was `develop/soft`)
  - Feature branch: `garelier/<base-slug>/feature/#<id>/<slug>`
    (was `feature/#<id>/<slug>`)
  - `trunk/soft` tier **removed**: PM no longer owns a branch and
    initiates releases by merging develop into base directly on
    user instruction.
- **Base slug convention**: `<base-slug>` is `<base>` with `/`
  replaced by `-` (e.g., `develop/soft` → `develop-soft`), keeping
  branch depth constant and avoiding git ref-hierarchy collisions.
- **Setup wizard**: now asks for `<base>` (default: current branch),
  handles base-slug conversion, no longer creates `trunk/soft`,
  integrates `<base>` before adding new worktrees in diff mode.
- All SKILL.md, templates, and docs updated to the new paths and
  branch names. CLAUDE.md (repo-level) reflects the new structure.

### Added

- DEC-001 (restructure to Garelier; remove trunk tier) — DEC for this
  restructure and rename.
- `docs/project_state/` — `roadmap.md`, `backlog.md`, `current.md`,
  `notes.md` for repo-level work management.
- `CLAUDE.md` at the repository root, summarizing the framework
  architecture for future Claude Code instances.
- **Base tracking**: Dock runs `git merge <base>` into the
  integration branch before each new feature worktree and before
  each merge gate; PM runs the same before release. Conflicts are
  resolved by Dock/PM themselves (defined exception to the
  "no code writing" boundary; see DEC-001 §2.5).
- `release_candidate.md` template gained a "Base-tracking status"
  section.
- `history.md` Outcome values gained `released` and
  `merge-resolution`.
- Setup wizard exit code 3 for diff-mode base-tracking conflicts
  (PM resolves and re-runs).

### Removed

- `trunk/soft` branch and the release-candidate tier between
  develop and the base branch.
- Hardcoded path literals `.workspace/`, `_pm/`, `_dock/`,
  `_workers/`, `_scouts/` (replaced by `__garelier/` prefix).

### Migration

None. v0.1.0 had no production install base; v0.1 → v0.2 is a
one-way cutover.

### Decisions

- **`__garelier/` is visible, not hidden** (vs `.garelier/`).
  Chosen for visibility in directory listings; the workspace inside
  no longer needs its own dot-prefix because the parent already
  provides isolation.
- **Base name carries through the branch hierarchy** as the slug
  segment (`garelier/<base-slug>/...`), enabling multi-base use in
  one repo (e.g., `garelier/main/develop` and
  `garelier/release-v1/develop` could coexist; setup wizard
  currently handles one base per project).
- **Conflict resolution exception**: base-tracking merges that
  produce conflicts are resolved by Dock/PM themselves rather
  than escalated. This is the only place those roles modify
  non-PM-owned files; framed as integration work, not feature
  implementation.
- **Worker is unaffected by base divergence**: conflicts surface on
  the integration branch (Dock's domain) or in feature ←
  develop merges (Worker handles when re-syncing). Workers never
  touch `<base>` directly.
- **No migration script provided**: v0.1.0 had no production
  install base; cutover is acceptable.

## [0.1.0] - 2026-05-06

### Added

#### Repository scaffolding
- `README.md` (bilingual JP/EN) with framework overview and bootstrap guide
- MIT `LICENSE` (copyright placeholder for the user to fill)
- `.gitignore` for OS, editor, and backup artifacts
- `install.sh` (bash) and `install.ps1` (PowerShell) for symlinking
  skills into `~/.claude/skills/`

#### Documentation
- `docs/concepts.md` — framework concepts and role model
- `docs/protocol.md` — file-based message protocol specification
- `docs/state_machine.md` — Worker and Scout state transitions
- `docs/getting_started.md` — bootstrap guide for new projects

#### Skill: `garelier-core` (shared reference)
- `SKILL.md` — framework invariants, branch hierarchy, role summary
- `protocol.md` (operational) — directory layout, ownership matrix,
  file naming, persistence rules, concurrency rules, failure modes
- `state_machine.md` — Worker and Scout states, transitions,
  escalation flow, state invariants, recovery procedure
- `templates/`: `manifest.md`, `setup_config.toml`, `agents.md`,
  `workspace_gitignore`, `assignment.md`, `report.md`, `state.md`,
  `questions.md`, `escalation.md`, `research_report.md`,
  `status_summary.md`, `inbox_notification.md`

#### Skill: `garelier-pm` (Project Manager role)
- `SKILL.md` (§1–§14) covering pre-flight, responsibilities,
  boundaries, setup wizard flow, spec authoring,
  milestone/roadmap management, escalation handling, release flow,
  agent add/remove (diff-mode wizard), conversation guidelines,
  templates index, history tracking, spec re-execution,
  running-display + clean stop, optional health check
- `templates/spec.md` — specification of work to be done (covers
  feature work, refactors, single tasks, investigations, recurring
  processes — all in one template)
- `templates/milestone.md` — milestone definition with `Specs included`
- `templates/roadmap.md` — project roadmap template
- `templates/release_candidate.md` — pre-merge review template
- `templates/history_entry.md` — one entry in `_pm/history.md`
- `scripts/setup_wizard.sh` — bash setup wizard with **fresh** and
  **diff** modes
- `scripts/setup_wizard.ps1` — PowerShell port (fresh + diff modes)

#### Skill: `garelier-dock` (central dispatcher)
- `SKILL.md` (§1–§14) covering pre-flight, responsibilities,
  boundaries, the main loop, spec expansion decision (workflow vs
  phase-decomposed), Worker/Scout routing, assignment authoring,
  inbox processing, Worker report review, Scout research review,
  merge gate (feature → develop/soft) with fail-closed semantics,
  backlog management (pending / in_flight / done), manifest updates,
  PM escalation flow, periodic status summaries, templates index
- `templates/phase_breakdown.md` — Dock's record of how a spec
  was decomposed into phases
- `templates/review.md` — review feedback returned to a Worker when
  rework is needed (Worker only — Scout reports are immutable)

#### Skill: `garelier-worker` (commit-producing implementer)
- `SKILL.md` (§1–§14) covering pre-flight, responsibilities,
  boundaries, state machine reference, assignment receipt,
  implementation discipline, quality gate, report writing, REWORK
  handling, post-merge cleanup, BLOCKED escalation, multi-Worker
  coordination, templates index

#### Skill: `garelier-scout` (commit-free investigator)
- `SKILL.md` (§1–§11) covering pre-flight, responsibilities,
  boundaries, simplified state machine (no REVIEWING/MERGED/REWORK),
  assignment receipt, investigation discipline, deliverable writing
  to `.workspace/scout/<cat>/<topic>.md`, immutable-report rule,
  BLOCKED escalation, web search etiquette

#### Wizard features (in addition to fresh-init)
- **Diff mode** (`--mode diff` / `-Mode Diff`): compares current
  `_pm/setup_config.toml` against the desired agent set passed via
  `--workers`/`--scouts`, applies only the differences, refuses to
  remove agents whose `STATE.md` is not `IDLE` (exits with code 2),
  rebuilds the manifest tables, appends a history entry.
- **History initialization**: fresh-mode wizard creates
  `_pm/history.md` with entry #001 and `_pm/spec/archive/` for
  shipped/abandoned specs.
- **Optional health check**: fresh-mode wizard emits a commented
  `[health_check]` section in `_pm/setup_config.toml` so the user
  can opt in by uncommenting (PM SKILL.md §14).

#### PM-side features
- **History tracking** (`_pm/history.md`): append-only log of every
  spec PM dispatches plus structural events (project init, agent
  set changes). Sequential numbering preserved across the project's
  lifetime.
- **Spec re-execution**: user can ask "re-run #042" or by topic.
  PM finds the entry, copies the spec to a new slug with a numeric
  suffix (`-2`, `-3`, …), updates its Context to record the
  re-execution origin, and confirms the milestone before commit.
  Pairs with Claude Code's `/loop` for periodic recurrence
  (Garelier itself does not schedule).
- **Running display**: user asks "what's running" and PM produces a
  table by reading every `_workers/<id>/STATE.md` and
  `_scouts/<id>/STATE.md` plus Dock's own state.
- **Clean stop**: user picks an active task; PM writes
  `_workers/<id>/abort.md` (or scouts/) which the target agent's
  state machine handles at its next session boundary, performing a
  clean shutdown rather than leaving WIP in an indeterminate state.

### Decisions
- TOML key for Scout configuration is `[[scouts]]` (not
  `[[researchers]]`).
- **Branch naming**: Garelier creates `trunk/soft` (release) and
  `develop/soft` (integration) under the user's existing default
  branch (typically `main`). The user's `main` branch is **never
  modified or renamed** — `trunk/soft` is branched off from it,
  `develop/soft` from `trunk/soft`. Worker feature branches use
  `feature/#<id>/<slug>` (no prefix needed since `feature/` does
  not conflict with any user branch). This preserves the user's
  `main/`-style hierarchy potential while avoiding git's ref-hierarchy
  conflict (a branch named `main` blocks `main/soft`).
- **Worker vs Scout boundary** is determined by **whether the task
  produces commits**. Worker = commits (feature branch).
  Scout = no commits (output to `.workspace/scout/<cat>/<topic>.md`).
  Scout therefore covers both "investigation" tasks (web research,
  market study) and "workflow execution" tasks (accounting, deploy
  checks, full test runs, benchmarks, external API health checks).
- **`.workspace/` directory naming follows role names**:
  `.workspace/dock/`, `.workspace/pm/`, `.workspace/scout/`.
  Scout deliverables organized under freely-named category
  subdirectories (`tech/`, `market/`, `status/`, plus user-defined
  ones like `accounting/`, `deploy_check/`, `test_results/`).
- **PM authors only specs**, not workflows. The user → PM dialogue
  is uniform: PM translates user intent into a spec and links it
  to a milestone. The decision of how to execute that spec
  (multi-phase decomposition vs. single-agent assignment) belongs
  to Dock.
- **Scout reports are immutable**. Once a Scout writes a report and
  transitions to REPORTING, the report stands as historical record.
  If supplementation is needed, Dock issues a follow-up
  assignment with a new task ID; the original report is not edited.
  This contrasts with Worker REWORK, where the same Worker
  addresses feedback on the same feature branch.
- **PM does not auto-monitor agent health**. Health check is opt-in
  via `[health_check]` in `setup_config.toml` and runs only when
  the user explicitly invokes it. The always-available alternative
  for stopping work is the running-display + clean-stop path
  (PM SKILL.md §13), which never relies on any threshold.
- **Re-execution slug suffix is numeric** (`-2`, `-3`, …), not
  alphabetic or date-based. This keeps slugs short and lets repeat
  iteration counts be read directly off the slug.
- **`_pm/history.md` is append-only**, with three exceptions:
  updating an entry's `Milestone:` line, changing `Outcome:` from
  `in-progress` to a terminal value, and appending to the `Notes:`
  free-text field.
- Worker and Scout state files live in their respective worktrees
  (`_workers/<id>/STATE.md`, `_scouts/<id>/STATE.md`) for symmetric
  treatment.
- `_pm/` and `_dock/` are **subdirectories** of the primary
  worktree, NOT separate worktrees. Both share the `develop/soft`
  branch via the primary worktree. Only Worker and Scout
  directories are separate `git worktree` instances.
- `.workspace/` is fully gitignored in v0.1.0. Selective tracking
  of `scout/` and `backlog/done/` deferred to a future release.
