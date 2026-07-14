# Changelog

All notable changes to Garelier are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Bilingual note / 言語について.** Entries from this release onward are written
> in both English and Japanese (日英併記); existing entries below remain in
> English. / 本リリース以降のエントリは日英併記で記載します。過去のエントリは
> 英語のままです。

## [Unreleased]

## [2.12.0] - 2026-07-14

Thirteen field-driven hardening items from live multi-lane operation (13 open
workshop rows drained to zero in one pass). / 実運用 (多 lane 並走) で溜まった
workshop 残件 13 件を一括完遂した hardening リリース。

### Added / 追加
- **W-071 — stale-premise detection in `dispatch_prepare.sh`**: the emitted JSON
  now carries `stale_premise_warning` (+ a stderr warning) when the task ids
  bound to the dispatch (`--tags`, the `wNNN` slug prefix) already appear in the
  integration branch's history — the "backlog row says ready but the work
  already landed" class burned two dispatches in the field. Advisory; the PM
  keeps the final call. / dispatch が bind する task id が統合 branch の履歴に
  既出の時、JSON + stderr で警告 (stale row への空撃ち 2 件の再発防止、advisory)。
- **W-070 — PM read_first surfaced in `dock_status`**: the status output every
  session start runs now embeds the PM's knowledge `read_first` list
  (`pmReadFirst` JSON key / a text-format block), making session-start
  grounding un-skippable. / dock_status が PM の read_first 一覧を機械同梱。
- **W-064 — `merge_request_id_recover.sh`**: when `merge_land.sh` cannot parse
  the submitter's stdout JSON, it now recovers the request id from evidence
  (the "wrote <path>" stderr line, else the newest request file guarded by
  --since) instead of false-aborting a real request. / stdout parse 失敗時に
  request file の実在から request_id を回収し false-abort を廃止。

### Fixed / 修正
- **W-061 — merge gate wedge on a stale heavy-compile slot**: the gate's lock
  acquire is now explicitly bounded (30 min, fail-open), a waiter names the
  SUSPECT dead-owner slot it is stuck behind (once, with owner info), and
  `dispatch_cleanup.sh` runs a best-effort stale-slot sweep at dispatch end —
  the 90-minute all-lands wedge cannot silently recur. Reclaim semantics are
  unchanged (a live build is never touched). / gate の lock 待ちを 30 分で
  fail-open 化 + SUSPECT slot の名指し警告 + cleanup 終端での stale sweep。
- **W-066 — PM-commit-during-gate absorb backstop**: the merge gate pins the
  HEAD it staged onto and refuses to commit (aborting with recovery guidance)
  when HEAD moved / MERGE_HEAD vanished mid-gate — the mechanical answer to a
  judgment rule that broke three times. / gate が staging 時 HEAD を pin し、
  吸収事故を検出したら mislabeled merge を重ねず明示 abort。
- **W-072 — codex proxy seats no longer told to base-track**: the proxy
  prompt-preamble now assigns base-tracking to the Dock seat at proxy-commit
  time (the sandbox denies gitdir writes, so every codex dispatch opened with a
  doomed EXIT-128 merge). / proxy preamble の base-track 指示を Dock seat 責務に
  条件分岐 (codex の恒常 EXIT 128 を構造的に解消)。
- **W-073 — gate verdict vocabulary drift**: `merge_request.sh` normalizes the
  PM-typed near-synonym `PASS_WITH_CHANGES` → `PASS_WITH_NOTES` with a warning
  (the report-side parser stays strict/fail-closed), and the attended-gate
  reference now instructs quoting the canonical menu verbatim in gate prompts.
  / CLI 境界でのみ近縁語を正規化、report 側 parser は厳格維持。
- **W-060 — export lost every executable bit**: `make-public-export.sh` now
  propagates the dev index's 100755 modes into the export index and ABORTS if
  any `.sh`/`bin/` file would ship 100644; `ci.sh` gained a version-drift check
  (VERSION vs plugin manifests / README / setup_wizard literals). / export の
  +x 全喪失を dev index 伝搬 + commit 前 detective で封止、version drift を CI 化。
- **W-068 — public-repo direct-commit trailer leak**: machine-local
  commit-msg/pre-push hooks on the public clone reject AI-assistant trailers /
  session URLs / private names; the release runbook documents the direct-commit
  rules and hook re-install. / 公開 clone 直接 commit 経路に trailer 拒否 hook。
- **W-074 — proxy commit-mode discoverability**: `--commit-mode` is now listed
  in `dispatch_prepare.sh` usage (the auto-proxy mechanism for codex seats
  existed but was invisible, so PMs prepared with the wrong mode). /
  --commit-mode を usage に明記 (機構は実在、発見可能性の穴)。

### Documentation / 文書
- **W-065** — verdict-before-idle contract for gate agents (marker file +
  register message BOTH before idling; the result file is the verdict
  canonical; a silent-idle gate is re-dispatched, never self-authored).
- **W-067** — the runtime-status marker is an APPEND to the final message, not
  a replacement; a marker-only final message is treated as a stall and
  re-requested via SendMessage.
- **W-069** — codex playbook: canonical probe form (foreground, stdin closed,
  read-only low effort), the W-062 default skills grant, and a "grep this
  playbook before self-diagnosing" pointer.


## [2.11.4] - 2026-07-13

### Fixed / 修正
- **W-058 — `heavy_compile_lock` acquired/released the wrong directory from a
  linked worktree**: the shared heavy-compile lock built its path from the
  caller's `--project` verbatim, so a dispatch checkout inside a linked git
  worktree acquired a slot under its own worktree-local `runtime/locks/`
  instead of the main repo's — silently bypassing the serialization that
  prevents concurrent ~16 GB compiles from OOMing the box. `resolveMainRoot()`
  now maps `--project` to the git-common-dir side so both acquire and release
  land on the main-root lock; release additionally resolves the token's slot
  name against the main-root dir (instead of testing the token path verbatim)
  so a mismatched/worktree-local token no longer no-ops silently, and now
  exits non-zero when the expected slot is absent everywhere. Fails open to
  unchanged behavior on any git error. / 共有 heavy-compile lock が `--project`
  を素通しで組み立てていたため、linked worktree からの呼び出しが本体 repo とは
  別の worktree-local ディレクトリに slot を取得/解放しており、同時 ~16GB
  compile による OOM 防止の直列化が黙って迂回されていた問題を修正。acquire/
  release とも main-root 側へ解決するようにし、release は token 検証もそのまま
  行うのではなく main-root 側の slot 名で解決、期待した slot が存在しない場合は
  黙って成功を返さず非ゼロで終了するようにした。
- **W-062 — codex sandbox missing `$CODEX_HOME/skills` read grant caused
  dispatched codex producers to exit fatally**: a newer codex release turned a
  skill-load stat failure from a warning into a fatal error, and
  `dispatch_codex_producer.sh`'s sandbox (both workspace-write and read-only)
  did not grant that directory, so dispatched codex threads terminated
  immediately after launch. Added `$CODEX_HOME/skills` to the default
  `--add-dir` set; hosts where the directory does not exist are silently
  skipped (the existing `add_dir_unique` / `resolve_dir_native` guard).  /
  新しい codex 版が skill-load の stat エラーを warning から fatal 化しており、
  dispatch_codex_producer.sh の sandbox がこの dir を grant していなかったため
  dispatch した codex が起動直後に終了していた問題を修正。既定の `--add-dir`
  群に `$CODEX_HOME/skills` を追加 (dir が存在しないホストでは黙って skip)。

### Added / 追加
- **W-059 — `verify_register.ts`, a mechanical register-claim verifier**: a
  new PM-facing CLI that re-derives a completion register's git claims from
  the actual repository before any external action (merge_land, push, tag,
  release) — checking that claimed commits exist, a claimed tag exists and
  peels to the claimed commit, a branch tip matches, a worktree is clean, and
  a named gate-verdict file actually contains the claimed verdict. Supports
  both authoritative CLI flags (`--commit`/`--tag`/`--branch`/
  `--worktree-clean`/`--gate`) and a best-effort, label-gated register parse
  (`--register`). Responds to a 2026-07-13 incident where a producer reported
  three fabricated commit SHAs, a nonexistent tag, and a gate PASS the
  verdict file did not support. / 完了 register の git claims (commit/tag/
  branch/worktree/gate verdict) を実 repo に対して機械的に再検証する新規 CLI
  `verify_register.ts` を追加。producer が捏造 SHA / 存在しない tag / 未裏付け
  PASS を報告した実インシデントへの対応。
- **W-063 — compaction stall sweep via `SessionStart`/`PreCompact` hooks**:
  Claude Code stops background subagents on context compaction/resume, but a
  dispatch container's `STATE.md` stays `WORKING`, so a dead worker could sit
  idle for hours before a manual status sweep caught it. Extended the
  existing runtime-recovery hook: `PreCompact` snapshots in-flight dispatch
  lanes; `SessionStart` (compact/resume) scans `_dispatch*/STATE.md` for
  non-terminal lanes and, if any are found, injects a
  `GARELIER_COMPACTION_SWEEP` context (lane id/task/last activity plus a
  restart instruction) instead of relying on the PM noticing on its own. /
  Claude Code は compaction/resume で background subagent を止めるが dispatch
  container の STATE.md は WORKING のまま残るため、死んだ worker が手動 sweep
  まで長時間放置され得た問題への対処。PreCompact/SessionStart hook を拡張し、
  非終端 lane を検出したら再開指示付きの context を自動注入する。

### Changed / 変更
- **W-070 — PM `SKILL.md` gained a session-start checklist and a
  role-manual pre-read table, embedded in the skill body**: a 2026-07-13
  incident showed the PM's own pre-flight step for reading
  `role_index.toml` / the PM read-first set was a judgment-only instruction
  that broke in practice. Embedded a session-start checklist (dock_status +
  stall-scan + resume note + read-first) at the top of the Default PM
  Iteration section, and a role → manual pre-read table (Worker/Scout →
  worker_field_manual, gate roles → gate_field_manual, Smith/Librarian/
  Artisan/Concierge → their SKILL + knowledge) directly in the SKILL.md body
  so dispatch-time reads no longer require an extra file hop. / PM の
  pre-flight (role_index / read-first の事前読了) が judgment 依存で実戦破綻
  した事例を受け、session-start checklist と役割別 manual 事前読了表を
  SKILL.md 本文へ直接埋め込み、dispatch 前の追加 file hop を削減。

## [2.11.3] - 2026-07-13

### Fixed / 修正
- **W-055 — `merge_land.sh` aftercare crash on a missing driver dir**: a
  `DOCK_MERGE_TS="$(cd … && pwd -P)/dock_merge.ts"` assignment had no `|| true`
  fallback (unlike its `PARSER_DIR` sibling a few lines above); under `set -e`,
  a failed `cd` silently killed the whole script before cleanup, pull, or
  `--close-row` ever ran, with no diagnostic. Added the missing `|| true`,
  hardened the same unguarded-cd pattern in `dispatch_cleanup.sh`, and added
  an EXIT trap that reports "merge LANDED but aftercare crashed" for any
  future unforeseen crash after a confirmed gate success. / merge_land.sh の
  driver dir 解決に `|| true` が欠落し、`set -e` 下で cd 失敗時にスクリプト全体が
  無診断で死亡、cleanup/pull/--close-row が飛んでいた問題を修正。同種パターンを
  dispatch_cleanup.sh でも防御し、着地後クラッシュを検知する EXIT trap を追加。
- **W-054 — merge gate false "aborted" after a successful landing**:
  `cleanup_and_abort()`'s ERR trap declared `aborted` whenever `STATUS` was
  still empty, with no check for whether the merge had actually landed — a
  narrow window right after `git commit` succeeds but before `STATUS="success"`
  is assigned. Added a landed-check (workbench branch ancestor-of-HEAD) before
  declaring abort; a genuinely landed merge now reports success with an
  aftercare warning instead of a false abort. Also adds a warn-level `ci.sh`
  lint for commit messages that claim 起票/close of a backlog row without the
  diff actually touching a matching row line. / merge gate が実際は着地済みの
  merge を false "aborted" と報告していた問題を、着地済みチェックの追加で修正。
  起票/close を主張する commit message が実際に該当行を触っているか検証する
  commit lint も追加。
- **W-056 — `merge_gate_detach.test.ts` flake under parallel load**: the
  `parentElapsedMs < 3000` hard real-time bound left only ~2s of slack above
  bun-startup-under-load before conflating "detached" with "blocked" (measured
  3339ms once). Widened the dummy gate duration and the parent-return bound so
  a genuinely blocking spawn is still cleanly discriminated while absorbing
  load-induced jitter. / 並列負荷下で flake していた merge gate detach test の
  hard real-time bound を、判別力を保ったまま緩和。
- **W-057 — milestone `Shipped` field had no version/date home**: `Status:
  shipped (v2.10.0, 2026-07-06)` correctly fails `control_graph`'s strict
  Status enum, but the pre-existing `Shipped:` field had no defined format for
  the version. Accept `Shipped: <version> (<date>)` (or a bare date, or `-`);
  backfilled the ship version onto every currently-shipped milestone. /
  milestone の Shipped field に version+date を記録できる正規形式を追加し、
  既存 shipped milestone へ backfill。

## [2.11.2] - 2026-07-12

### Added
- **W-033 — verbatim, judgment-free wake/watch/cleanup commands on every
  `--stall-scan` actionable finding**: `IDLE-NO-REGISTER` already carried a
  ready `wake_cmd`; `UNWATCHED` and `UNPROCESSED-RESULT` only had PROSE
  ("copy watch_cmd from the dispatch_prepare JSON output" / "run
  dispatch_cleanup.sh (--delete-branch) on each") that made the attended
  operator hand-compose `--project`/`--pm-id`/`--id`/`--target-root` from
  memory — friction the mechanization was supposed to remove.
  `contract_check.ts`'s `unprocessed_results[]` now carries a `cleanup_cmd`
  and a new `unwatched_detail[]` array pairs each unwatched dispatch id with
  a `watch_cmd`, both absolute-path one-liners built the same way
  `dispatch_prepare.sh`'s own `watch_cmd` is (resolved at emission time, not
  a relative guess); `fleet_watch.sh`'s `FLEET-ATTENTION` JSON passes both
  straight through. This closes the row's SMALLER, DEC-066-compliant scope:
  the row as originally filed asked for a persistent driver process to
  inject wakes directly into a worker session with zero LLM involvement —
  DEC-066 (2026-06-11, before this row was filed) deleted that execution
  model outright on explicit operator directive, so garelier's contract now
  stops, by design, at emitting an executable `*_cmd`; delivering it into a
  live session is a harness/FleetView-level capability out of scope here
  (documented as an explicit architectural boundary in `pm_playbook.md`).
  / stall-scan の 3 種の actionable finding (idle_no_register/unwatched/
  unprocessed_results) 全てに「そのまま実行できる command」を持たせ、PM の
  手組み立てを排除。真のゼロトークン driver 注入は DEC-066 で撤去済みの
  実行モデルの再導入になるため対象外と明示 (アーキテクチャ境界を文書化)。
- **W-042 — codex proxy-commit seat mode**: external (codex) seats cannot write a
  dispatch worktree's gitdir (the sandbox re-pins `.git`/gitdir targets read-only
  AFTER `--add-dir` grants — upstream openai/codex #14338/#15505; Windows DENY
  ACEs #18918). `dispatch_prepare` now resolves `commit_mode` (codex seats default
  `proxy`; flip with `--commit-mode self` / `GARELIER_EXTERNAL_SEAT_COMMIT=self`
  when the upstream opt-in lands), emits it in the JSON, and ships a proxy-commit
  preamble: the producer edits + gates only and reports a commit plan; the Dock
  (often the PM sitting in the Dock seat) proxy-commits verbatim with the
  mandatory provenance trailer `Garelier-Seat: codex <model> (proxy-commit via
  dock seat)`; gates review that SHA. / commit 不可な codex 座席の恒久運用を機構化。
- **W-043 — lane selection reference** (`garelier-core/references/lane_selection.md`):
  the PM picks the produce pattern by criteria; anti-rules + the concurrency ops
  rule that replaces a lane.lock (user decision: no lock). Mechanism/preventive
  work is Dock-regulated: even PM/Artisan-authored changes REQUIRE Observer +
  Guardian gates.
- **W-044 — field investigation formalized**: standalone advisory audits
  (`ga-audit-<topic>`, read-only, no lane/branch/STATE, report to
  `runtime/observer/results/<topic>-audit.md`, PM disposition commits accepted
  findings).
- **W-042 hardening (guardian findings 2 + 7)**: `lane_selection.md`'s
  external-op hard rule now requires a Guardian preflight scan of exactly what
  leaves the sandbox (pushed range / tagged tree / release artifact) for
  secrets/credentials/PII on BOTH the user-instructed PM-direct path and the
  Concierge lane — user instruction gates the decision, Guardian gates the
  payload — and requires the authorization record to be a verifiable
  reference (user-message timestamp/instruction quote) logged to the PM's
  `_pm/history.md` (PM-direct) or the concierge op record (Concierge lane),
  not a free-text paraphrase. `lint_commits.ts` gained an opt-in
  `--require-seat-trailer` flag (usable with `--last`/`--range`/stdin/a
  message file) that hard-fails a missing or malformed `Garelier-Seat: codex
  <model> (proxy-commit via dock seat)` trailer, making that provenance
  marker machine-checkable for the Dock validating a `commit_mode=proxy`
  dispatch's commit; default lint behavior is unchanged unless the flag is
  passed. / guardian W-042 hardening 2 件: 外部 op の 2 経路双方に Guardian
  事前 payload scan を必須化 + 認可記録を検証可能な参照に限定、
  `lint_commits.ts` に `--require-seat-trailer` opt-in flag を追加し
  Garelier-Seat trailer を機械検証可能化。
- **Attended-dispatch output control**: `dispatch_prepare.sh`'s
  `PROMPT_PREAMBLE` now carries its own distilled output-control directive
  (compressed register: no greeting/thanks/request-echo/self-narration,
  durable detail into `report.md`/`STATE.md` not the response, ids/SHAs/
  paths replace re-explanation, never shorten code/paths/commands/error
  text/numbers/SHAs/risks) — closes a reachability gap where a producer
  dispatched attended (not through the driver's iteration loop) never
  received `output_control.md`'s per-iteration directive and defaulted to
  verbose self-narration. `output_control.md` cross-references the
  injection site. / attended dispatch の producer にも output_control の
  compressed register 指示が届くよう preamble に注入。

### Fixed / 修正
- **W-031 — `review_gate_prep.test.ts` flake under heavy parallel load fixed at
  the root cause**: the "Guardian prep" test spawned a REAL `bun
  guardian_scan.ts` subprocess just to prove `buildReviewGatePrep` wires a scan
  draft path into its result — `guardian_scan.ts`'s own scan logic is already
  unit-tested in-process by `guardian_scan.test.ts`. A real subprocess pays
  full interpreter-startup cost, which is fine standalone but is exactly what
  made the test contention-sensitive under a heavy parallel `bun test` load
  (observed 7814ms vs. the 5000ms default per-test timeout; 916ms standalone —
  a timing assumption bug, not a hang). Added an injectable
  `spawnGuardianScan` seam to `buildReviewGatePrep` (same pattern as
  `merge_gate.ts`'s `spawnFn`); the primary test now stubs it out (fast,
  deterministic, load-immune) and a new second test keeps a REAL-subprocess
  integration case with an explicit, justified per-test timeout (20000ms) for
  the one case that legitimately needs it. / 重い並列 `bun test` 負荷下で
  flake していた review_gate_prep のガード test を、実 subprocess spawn 依存
  という真因ごと修正 (guardian_scan.ts 自体は guardian_scan.test.ts が
  in-process で既にカバー済み)。`spawnGuardianScan` injection seam を追加し、
  主 test は高速 stub 化、実 subprocess 経路は明示 timeout 付きの別 test へ分離。
- **W-053 — `merge_land.test.sh` / `dispatch_cleanup.test.sh` cwd isolation**:
  target project 実戦 (2026-07-12) で a literal `$DT/__garelier/tpm/runtime`
  directory was found sitting in a real project root. Inspection of both test
  files found no reproduced leak in their own fixtures (each already scopes
  itself under `mktemp -d`), but the TOP-LEVEL process cwd itself was still
  whatever the invoker launched the script from — any future latent path bug
  in `merge_land.sh`/`dispatch_cleanup.sh` that resolved against cwd instead of
  its `--project`/`--target-root` argument would land there. Both test files
  now `cd` into their own throwaway `mktemp -d` scratch cwd before running any
  case, and assert on exit that the ORIGINAL invoker cwd picked up no stray
  literal-`$`-prefixed directory — a self-detecting backstop, not just
  prevention. Part (b): `dispatch_cleanup.sh`'s `--target-root` CLI arg had NO
  validation at all — the one asymmetric gap against the W-045 trio
  (`merge_gate.ts` / `merge_gate_parse.ts` / `merge-gate.sh`, all guarded).
  Brought it in line with the identical guard (absolute + no literal `$` +
  names an existing directory, else fall back to `--project` untouched); a new
  test proves a malformed `--target-root '$DT'` neither creates a stray dir
  nor silently no-ops the cleanup (falls back and still deletes the branch).
  / target project 実戦での literal `$DT` 残骸再発を受け、両 test file のトップレベル
  cwd を throwaway scratch dir へ隔離 + 元 cwd の残骸 assert を追加
  (再発の自己検出)。(b) dispatch_cleanup.sh の `--target-root` 無検証も
  W-045 と同じ guard で是正。
- **W-045 — stray `$VAR`-named directory leak (detective guard)**: a
  request/lock JSON's `target_root` field is untrusted (hand-edited, a
  broken test fixture, a stale/foreign lock, ...); `merge_gate.ts`'s
  `requestTargetRoot()`, `merge_gate_parse.ts`'s (now exported)
  `resolveTrustedTargetRoot()`, and `merge-gate.sh`'s inline
  `TARGET_ROOT_FOR_GIT` resolver all used to resolve a non-absolute value
  AGAINST the real project root and trust the result — so a malformed
  relative string (e.g. a literal, unexpanded `$DT`) silently became a real
  absolute path the spawn cwd / `cd` step then used, planting a stray
  literal-named directory inside the real project. All three now require the
  value to be absolute, contain no literal `$`, and name an existing
  directory; anything else falls back to the safe default untouched.
  `merge_land.test.sh`'s `plant_lock.sh` fixture also switched from an
  embedded-literal `printf` format string to `%s`+arg for clarity. See
  `references/stray-var-dir-leak.md`. / `target_root` を信頼して resolve
  していた 3 箇所 (merge_gate.ts / merge_gate_parse.ts / merge-gate.sh) に
  絶対パス + 実在ディレクトリ検証を追加、不正値は fallback へ skip。
- **W-046 — merge-gate-active studio commit guard surfaced in `dock_status`**:
  the async merge gate stages its merge (`git merge --no-commit`) in the
  primary checkout's shared index while it runs; a studio commit made during
  that window can clobber the staged merge and abort the gate (DEC-075,
  #237 incident). `hooks/pre-commit` and `pm_commit.sh` already mechanize
  this, but both require an opt-in per-project install. `buildSnapshot()` /
  `dock_status.ts` now also emit a `merge_gate_active_commit_guard` warning
  ("MERGE-GATE-ACTIVE — do not commit to studio now") whenever the merge
  gate is active or queued, reusing the existing `active.lock` signal (no
  new lock) — reachable at commit time via the canonical status read without
  requiring the hook to be installed. / merge gate 稼働中の studio commit
  警告を `dock_status` の status 読み取りにも追加 (既存 active.lock 再利用、
  opt-in hook 不要で reachable 化)。
- **W-035 — producer preamble runtime-status marker restored**: an
  unescaped backtick in `dispatch_prepare.sh`'s preamble heredoc was
  command-substituting the `` `GARELIER_RUNTIME_STATUS: {...}` `` marker
  text out of every emitted producer preamble (silently broken since
  W-035 shipped), reddening the ci.sh "dispatch preamble runtime marker
  smoke" step and leaving producers never actually told the marker
  format — undermining the W-038 SubagentStop enforcement. Escaped the
  backticks so the literal marker text survives.
- The proxy-mode register-terminate line no longer demands a commit SHA
  a proxy producer can't have (it now reads "commit plan submitted,
  Dock commits"); a new ci.sh smoke covers the codex proxy-commit seat
  mode end-to-end (`commit_mode`, PROXY preamble text, `Garelier-Seat`
  trailer, output-control block, in both proxy and `--commit-mode self`
  forms); and `lane_selection.md`'s lane.lock retirement note now names
  its ~40-file load-bearing drift surface (canonical router, state
  machine, protocol/pipeline/control-contract docs, role skills, driver
  status consumers, scripts) instead of an undercounted three-item list.
  / W-035 の runtime-status marker 欠落を修正 (backtick escape)、proxy
  register-terminate 文言の mode-aware 化、codex proxy-commit seat mode
  の ci smoke 追加、lane.lock retirement scope 記述の実体拡充。
- **`--require-seat-trailer` now has a caller** (guardian round-2 N1):
  `context.json` forward-supplies `routing.commit_mode`, and
  `merge_land.sh` refuses to submit a `commit_mode=proxy` branch whose
  commits fail the lint (the Dock also self-checks after each proxy
  commit) — the machine-checkable half of guardian F2 was implemented
  but unreachable until now. / seat-trailer lint を merge_land の
  pre-submit 検証に接続し実際に呼ばれるように。
- **ci.sh self-mode negative assertions no longer inert** (guardian
  round-2 N2): the `!`-inverted `grep -q` checks were exempt from
  `set -e` and could not actually fail the step; rewritten as explicit
  `if`/`then` FAILs. / `!` 反転 grep が `set -e` の対象外で実質無効
  だった negative assertion を明示 if/then FAIL へ書き換え。
- **Seat-trailer preflight now fails CLOSED instead of failing open**
  (guardian round-3): an unresolvable dispatch container/`context.json`
  used to silently skip the check — a real gap, since the codex
  producer being checked holds `--add-dir` write access to that same
  container and could delete/strip it to disable its own provenance
  check. Now: `routing.commit_mode` absent/stripped falls back to
  `routing.model` (a second signal); a genuinely unresolvable container
  is a hard pre-submit error requiring an explicit
  `--seat-trailer <checked|skip>` override (same trust level as an
  explicit `--guardian`). / seat-trailer preflight を fail-open から
  fail-closed へ (producer が自分の container を書き換え可能なため)、
  commit_mode 欠落時は model へ fallback、判定不能時は明示 override
  必須のハードエラーに。
- **Seat-trailer preflight false-positive on base-tracking merges fixed**
  (observer round-3, REWORK_RECOMMENDED): `lint_commits.ts --range` used a
  two-dot `base_sha..HEAD` range, which walks BOTH parents of a merge
  commit — so the mandatory base-track step (merging the studio tip into
  the branch) pulled in unrelated studio-side commits via the merge's
  second parent, and the preflight blocked a fully correct proxy branch
  over a trailer some OTHER dispatch's commit never needed. `--range` now
  always uses `git log --first-parent` (the only caller in this repo,
  `merge_land.sh`'s seat-trailer check, wants exactly the branch's own
  history). / base-track merge の第二親経由で無関係な studio commit が
  range に混入し誤検知していた bug を `--first-parent` で修正。
- **Seat-trailer preflight residual: corrupted (not just missing) `context.json`
  now also fails closed** (guardian round-3 re-verification): the fail-closed
  fix only gated on file *presence* — a `context.json` overwritten with `{}`
  (content corrupted, not deleted) left both the `commit_mode` and `model`
  extractions empty, and the check silently no-opped with zero diagnostics
  (the same producer `--add-dir` write access, a subtler trigger than plain
  deletion). Now: when the file exists but NEITHER field yields a value,
  that specific combination is treated as unreadable content — mirroring
  `read_marker_verdict`'s absent-vs-malformed split — and fails closed the
  same way an unresolvable container does (an `--seat-trailer <checked|
  skip>` override is required to proceed). / context.json 存在するが内容が
  `{}` に破壊され両フィールドとも抽出不能な場合も fail-closed 化。
- **W-047 — incident hook runtime writes redirected off the target project**:
  the recovery hook wrote `.claude/runtime/garelier/` relative to whatever cwd
  fired it, landing as untracked noise wherever the project-root
  `.gitignore` doesn't reach (worker/dispatch worktrees nested under
  `__garelier/<pm_id>/...`). Now redirects to the already-gitignored
  `__garelier/<pm_id>/runtime/hooks/` when cwd resolves under a `pm_id`,
  falling back to the legacy cwd-relative path otherwise; the injected
  recovery-context message also points at the real resolved absolute path
  instead of a hardcoded relative literal. / incident hook の書込先を
  target project 直下から `__garelier/<pm_id>/runtime/hooks/` へ redirect
  (gitignored 領域)、案内メッセージも実 path を指すよう修正。
- **W-048 — `abortActiveGate`'s `target_root` now goes through the trust
  guard**: the one of four `target_root` read sites the W-045 guard
  (absolute + existing-dir only) had not yet reached; now imports
  `resolveTrustedTargetRoot` for parity with the other three sites, plus a
  `status_snapshot` test guarding against a false-positive
  `merge_gate_active_commit_guard` warning on an already-settled request.
  / merge_gate の 4 つ目の `target_root` 読み取り箇所 (`abortActiveGate`) を
  W-045 と同じ trust guard 経由に統一。
- **W-049 / W-050 — unmissable spawn model directive + real codex model
  detection**: the Agent tool silently inherits the parent session's model
  when `model` is omitted at spawn (observed in production: a worker + four
  gate subagents ran at the PM's own model). `dispatch_prepare.sh` now
  emits a `spawn_directive` field restating the resolved model/name pair,
  and resolves Guardian/Observer's own gate model into
  `gate_agents.guardian.model` / `gate_agents.observer.model`. Separately,
  external-seat detection only matched a literal `"codex"` substring, so a
  real codex model id (`gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra`) fell
  through to the Claude tier ladder and was silently clamped to sonnet;
  `model_routing.ts`'s `EXTERNAL_SEAT_RE` and a new single-source-of-truth
  `is_external_seat_model()` now also match `gpt-5\.\d` model names. /
  spawn 時の model 暗黙継承を防ぐ明示 directive を追加 + external seat 判定が
  実 codex model 名 (gpt-5.5 等) を誤って Claude tier に clamp していた bug
  を修正。
- **W-051 — seat-handover auto-detect in the `--require-seat-trailer`
  preflight**: a dispatch that starts on a codex proxy seat can hand over
  mid-flight to a Claude self-commit seat (e.g. codex quota exhaustion);
  `context.json` still says `commit_mode=proxy`, so the unconditional
  seat-trailer check false-positived on every later self-mode commit.
  `lint_commits.ts` gains `classifyTrailer()` / `--seat-summary`;
  `merge_land.sh`'s preflight now auto-switches to self-mode only when the
  evidence is fully consistent (all commits self, zero proxy, zero
  missing), always logging the switch loudly — any mixed/partial set still
  fails closed exactly as before. / codex → Claude self-commit への座席
  引き継ぎ発生時に seat-trailer preflight が誤検知していた bug を、証跡が
  完全に一貫する場合のみ auto-switch する形で修正。
- **W-052 — codex quota 3-step handling procedure documented**:
  `codex_worker_playbook.md` gains a compact procedure covering the observed
  silent 3-line exit-1 quota signature, sizing large waves to fit inside a
  quota window, and the standard recovery (audit partial output file-by-file
  for fmt-drift contamination before handing the remainder to a Claude
  self-commit seat per W-051). / codex quota 枯渇時の 3 手順運用を
  codex_worker_playbook.md に明文化。

## [2.11.1] - 2026-07-11

- W-038: SubagentStop が GARELIER_RUNTIME_STATUS marker 不在の終了を block (≤2、3 回目 escalation) — clean stall の構造的解決 / Block subagent turns that end without the runtime-status marker.
- W-039: codex 素叩き対策 — dispatch_prepare が codex seat に launch_cmd (dispatch_codex_producer.sh 一式) を発行 + command_guard に codex_raw_exec rule / Emit a ready-to-run codex launch_cmd and guard raw `codex exec`.
- W-040: model_routing に external seat pass-through (codex を tier ladder 外の runner として verbatim 解決) + scoped gate の bin/lib 判定 (bin-only crate への `--lib` 誤発行を修正) / External-seat routing + lib/bin-aware scoped test commands.
- W-041: message 経由指示の ledger 自記録規約 (instructions.md header + preamble) / Message-borne instructions must be self-appended to the instruction ledger before acting.
- playbook: codex 1312 真因確定 (Store MSIX pwsh stub → MSI 導入で解消) / worktree では commit 不可 (sandbox の .git 再帰保護、upstream 制限) → commit-plan 分業 / --model は config 許可名のみ。

## [2.11.0] - 2026-07-10

### Added / 追加

- **Runtime recovery hook (W-035).** New framework-owned Bun hook
  `garelier-core/hooks/runtime_recovery_hook.ts` wired to the officially
  documented `PostToolUseFailure` / `PostToolUse` / `SubagentStart` /
  `SubagentStop` events: Bash/PowerShell failures and output spills become
  machine-readable incidents in `.claude/runtime/garelier/incidents.jsonl`,
  subagents with an open incident are blocked at stop (twice) and told to
  recover, and the third stop escalates to the PM with a fixed marker. Field
  usage follows the official hook schema (`exit_code` / `error_message`;
  no undocumented fields). Ships with an installer (`settings.local.json`
  merge, idempotent, teardown-aware), setup-wizard wiring, a 7-case hook
  test, and `run_summarized --status-file` for checkpointed long commands.
  / Bash/PowerShell の失敗・出力退避を公式 hook event で incident 化し、
  未解決のまま終了しようとする subagent を最大 2 回 block して復旧させ、
  3 回目は PM へ機械可読 marker で escalation する framework 所有 hook。
  installer + wizard 配線 + teardown + 7 case test + `run_summarized
  --status-file` 同梱。
- **Self-guarding hook commands (W-037).** Hook entries written into a
  target's `settings.local.json` are now wrapped as
  `bash -c '[ -f hook ] && exec bash hook || exit 0'`, so removing the
  Garelier checkout without running teardown leaves silent no-ops instead
  of a failing hook on every tool call. Installers idempotently upgrade
  old-style entries in place. / hook 登録を存在 guard 内蔵形に変更 —
  teardown を経ずに Garelier を削除しても全 tool call が無音 no-op になる。
  旧形式 entry は installer 再実行/wizard diff で冪等 upgrade。
- **Codex worker playbook.** New general reference
  `garelier-core/references/codex_worker_playbook.md`: running Codex CLI as
  a Garelier producer (Codex-first / Claude-fallback policy, serial-one
  rule, sandbox constraints incl. the cargo spawn limitation, stdin-hang
  avoidance via `< /dev/null`, rate-exhaustion detection and recovery
  procedure written for a mid-tier PM). / Codex CLI を producer として運用
  する一般 playbook を新設（Codex first / 直列 1 本 / sandbox 制約 /
  stdin hang 回避 / rate 枯渇時の完全手順）。

### Fixed / 修正

- **command_guard now platform-independent (W-036).** `underContainer()`
  relied on host-native `path.resolve()`, so Windows drive-letter paths were
  not treated as absolute on a POSIX host — the public repo's ubuntu CI
  allowed `Remove-Item -Recurse -Force C:/...` that Windows correctly
  denied (v2.10.0 CI failure). Dangerous-path detection is now a pure
  string check covering drive-letter and UNC prefixes on every host, with
  both-side regression tests. / 危険 path 判定が host 依存で Linux CI では
  Windows 絶対 path を見逃していた (v2.10.0 の公開 CI fail の真因)。
  文字列判定に置換し全 host で同一判定に。回帰 test 両側追加。
- **PM commit guard scoped to the main worktree (W-158).** The pre-commit
  guard installed by `install_pm_commit_guard.sh` fired inside worker
  worktrees (hooks are shared across linked worktrees), pushing workers
  toward `--no-verify`. The hook now self-scopes via
  `git rev-parse --git-dir` vs `--git-common-dir` and skips linked
  worktrees. / PM 誤配置防止 guard が worker worktree でも誤発火していた
  問題を self-scope 化で解消。
- **Dispatch preamble hardening (W-032).** The generated worker preamble now
  permanently carries the background-gate discipline (long gates = one
  script via run_in_background; ending a turn silently at a milestone is a
  violation) and the PM manual pins the fleet-watch arming procedure
  (harness-tracked background only — shell `&` silences the net). Also
  restored missing executable bits on 28 tracked scripts and 1 straggler.
  / preamble に bg-gate 規律を恒久焼き込み、fleet_watch の arm 手順を
  manual に固定、tracked script の +x 欠落 29 件を復元。

### Docs / ドキュメント

- `pm_field_manual.md` gains §3.1/§3.2 (how to write gate requests with
  discriminating power / how to write investigation dispatches that don't
  get lost — distilled from live incidents), an agent-reuse policy
  (same-subject follow-ups reuse; new tasks, degraded agents, and gates go
  fresh), and the runtime-incident handling section (W-035). /
  pm_field_manual に §3.1/3.2 (gate 依頼・調査 dispatch の書き方) と
  agent 使い回し規則、runtime incident 処理 § を追加。
### Added / 追加

- **Framework-owned task_mirror PostToolUse hook (W-030).** The Task-list mirror
  refresh is no longer a per-project script the target repo has to carry. A new
  generic hook, `skills/garelier-core/hooks/task_mirror_hook.sh`, fires after a
  `merge_land` / `dispatch_prepare` / `dispatch_cleanup` Bash command, recomputes
  the mirror with `task_mirror.ts`, and injects ONLY the delta since the last emit
  into the PM session — no change means no output and zero tokens. It hardcodes no
  pm_id/project: both are parsed from the intercepted command (which always carries
  `--pm-id`/`--project`), so one installed copy serves every PM and project, and it
  exits silently if either is missing (誤爆ゼロ). The setup wizard's fresh and diff
  modes now merge this hook into the target project root's
  `.claude/settings.local.json` (merge-aware + idempotent via
  `install_task_mirror_hook.ts`, alongside the command_guard PreToolUse hook), and
  `--mode teardown` removes it. / Task リスト mirror の更新を、対象 repo が個別に持つ
  スクリプトから framework 所有の汎用 hook へ移管。land/dispatch コマンドの後に発火し、
  前回からの**差分だけ**を PM に注入する（差分ゼロ＝無出力＝トークン0）。pm_id/project
  は hardcode せず横取りしたコマンドから parse するため、1 本で全 PM・全 project を賄い、
  取れない場合は無音で exit（誤爆ゼロ）。setup wizard の fresh/diff mode が対象 project
  root の `settings.local.json` へ冪等 merge し、teardown で除去する。

### Docs / ドキュメント

- New `garelier-core/references/pm_field_manual.md` — a judgment-free companion
  to `pm_playbook.md` for a mid-tier PM model. Where the playbook is written as
  "situation → right move → rationale" (the reader must recognize the situation),
  the field manual distills the same operations into decision tables (mechanical
  trigger → the exact step to run) and numbered checklists: wake protocol
  (`idle ≠ wake immediately`; run `--stall-scan` first, then classify), the
  register-processing checklist, the canonical gate-request verdict path
  (`runtime/<role>/results/<branch-slug>-<role>.md` + a `## Verdict` section),
  `merge_land.sh --id`, heavy-compile-lock discipline with the manual stale-release
  steps (until W-024 automates liveness reclaim), the worker-dispatch mandatory-clause
  checklist, A/B confounder isolation, long-register part-splitting, and studio-commit
  discipline. Each section points back to the playbook §N for the "why"; the two do
  not duplicate. Adds `templates/gate_verdict.md`, the canonical verdict-marker
  template (its header documents the fail-closed parser contract). Wired into the
  PM SKILL reference table (W-025). / `pm_playbook.md` の判断不要な姉妹編
  `garelier-core/references/pm_field_manual.md` を新設。playbook が「状況 → 正しい手 →
  根拠(実例)」（読み手が状況を見分ける前提）なのに対し、field manual は同じ運用を決定表
  （機械的トリガ → そのまま走らせる手）と番号付き checklist に落とした mid-tier PM 向け:
  wake protocol（idle ≠ 即 wake、先に `--stall-scan` で分類）/ register 処理 checklist /
  gate 依頼の正準 verdict path（`runtime/<role>/results/<branch-slug>-<role>.md` +
  `## Verdict` 節）/ `merge_land.sh --id` / heavy-compile-lock 規律 + stale 手動解放手順
  （W-024 の自動 reclaim が入るまで）/ worker dispatch 必須文言 checklist / A/B 交絡排除 /
  長文 register の part 分割 / studio commit 規律。各節は根拠として playbook §N を指し、両者は
  重複しない。verdict marker の雛形 `templates/gate_verdict.md`（header に fail-closed parser
  contract を記載）も追加。PM SKILL の reference table に配線（W-025）。
- Companion `worker_field_manual.md` and `gate_field_manual.md` extend the same
  judgment-free genre to the roles that other environments run on opus/sonnet
  (Fable is not always available). The Worker/Scout manual covers cwd discipline,
  premise-verify-before-building, confounder isolation, register terminus,
  instruction ledger, and pre-existing hygiene; the gate-role manual covers the
  canonical verdict path, verification-level declaration, the test-tautology check,
  the scope-vs-pre-existing split, verdict/note semantics, and a 7-viewpoint Observer
  independent-review set (reproduce-don't-trust, failure-hypotheses-first, test
  discriminative power, three-dot diff, latent-risk naming, advisory discipline,
  verification-level declaration). Wired into the Worker/Scout/Observer/Guardian SKILL
  See-also sections (W-025). / 姉妹編 `worker_field_manual.md` と `gate_field_manual.md`
  で、同じ判断不要の genre を、他環境が opus/sonnet で回す role（Fable が常に使えるとは限らない）
  にも広げました。Worker/Scout 版は cwd 規律 / 実装前の前提検証 / 交絡排除 / register 終端 /
  instruction ledger / pre-existing hygiene を、gate 役版は verdict 正準 path / 検証水準の宣言 /
  test tautology 検査 / scope-vs-pre-existing / verdict・note 意味論、および Observer 独立レビューの
  7 視点集（再現するまで信じない / 故障仮説先出し / test 判別力 / three-dot diff / latent risk /
  advisory 規律 / 検証水準宣言）を扱います。Worker/Scout/Observer/Guardian SKILL の See-also に配線
  （W-025）。

### Self-driving dispatch health / 自走 dispatch の健全性監視

- `contract_check.ts --stall-scan` gained an `IDLE-NO-REGISTER` detective
  (`idle_no_register`): an idle dispatch the PM never processed a register for — a
  REPORTING producer whose completion register never arrived, a WORKING idle stall,
  or a gate role with no verdict — is surfaced with a ready-to-send `wake_cmd`
  (target Agent name + a state-specific Japanese wake body) so the PM wakes it
  verbatim instead of hand-writing the message. The single suppressor is a new
  `_dispatch<N>/register_received` marker the PM touches when it processes a
  register; `dispatch_watch.sh` (single, `--id`) surfaces the same as `RESULT:
  IDLE-NO-REGISTER`. A WAKE, not a respawn, and advisory (never flips `ok`). Fixes
  the 9-manual-wake friction of 2026-07-06 (W-018). / `contract_check.ts
  --stall-scan` に `IDLE-NO-REGISTER` detective (`idle_no_register`) を追加。register
  未処理の idle dispatch — 完了 register 未着の REPORTING producer / WORKING の停滞 /
  verdict 未着の gate 役 — を、そのまま送れる `wake_cmd` (宛先 Agent 名 + 状態別 wake
  文面) 付きで報告し、PM が文面を手書きせず wake できるようにしました。抑制は PM が
  register 処理時に touch する新 marker `_dispatch<N>/register_received` 1 つ。
  `dispatch_watch.sh` (single、`--id`) は `RESULT: IDLE-NO-REGISTER` で同判定を出します。
  respawn ではなく wake、advisory (`ok` は倒さない)。2026-07-06 の手動 wake 9 回の摩擦を
  解消します (W-018)。
- New `garelier-core/scripts/fleet_watch.sh` — a STANDING fleet stall watch that
  closes the three structural causes of an unattended stall (the "stalled 5×/day"
  analysis, 2026-07-07): (1) a sub-agent is run-to-completion and is not re-invoked
  until an external message, (2) `dispatch_watch.sh` is a finite run that leaves the
  fleet unmonitored once its window expires, and (3) the scan → wake step was a
  manual PM chore. It is a permanent loop that owns no stall logic of its own —
  every ~`--interval-sec` (default 300) it runs `contract_check.ts --stall-scan`
  and, the moment an ACTIONABLE item appears (`idle_no_register` / `unprocessed_results`
  / `unwatched`), prints one `RESULT: FLEET-ATTENTION` line + the detection JSON
  (wake_cmd included) and exits 0, re-waking the PM via the run_in_background
  completion notification; otherwise it keeps polling, so a stall is never left
  unmonitored by watch expiry. The only other exits are the driver stop file
  (`RESULT: FLEET-STOP`) and a `--max-hours` safety cap (`RESULT: FLEET-CLEAR`) —
  both a benign "re-arm". Classification (build-wait vs genuine stall, etc.) is
  100% delegated to `--stall-scan`, so it cannot false-wake a healthy cold build; it
  composes with `dispatch_watch` (single, per-heavy-producer) rather than replacing
  it. A `runtime/driver/fleet_watch.lock` (winpid, W-024 stale-liveness reclaim)
  refuses a double launch. Wired into the PM decision tables (pm_field_manual §1,
  pm_playbook §11) and ci.sh (`fleet_watch.test.sh`); the companion worker rule is
  in worker_field_manual §5 (never end a turn at a milestone in silence — always a
  register or a progress message / running background) (W-028). /
  `garelier-core/scripts/fleet_watch.sh` を新設 — 停滞放置の 3 つの構造要因（「停滞
  5×/日」分析、2026-07-07）を消す常設 fleet watch: (1) subagent は run-to-completion で
  外部 message まで再起動されない、(2) `dispatch_watch.sh` は窓が切れると無監視、(3)
  scan → wake が PM 手動。停滞 logic を一切持たない常設 loop で、既定 5 分ごとに
  `contract_check.ts --stall-scan` を回し、**actionable（`idle_no_register` /
  `unprocessed_results` / `unwatched`）を検出した瞬間だけ** `RESULT: FLEET-ATTENTION`
  ＋検出 JSON（wake_cmd 込み）を出して exit 0（run_in_background 完了通知で PM を再起動）。
  何も無ければ polling を続けるので、窓の期限切れで無監視になりません。他の終端は driver
  stop file（`RESULT: FLEET-STOP`）と `--max-hours` 安全上限（`RESULT: FLEET-CLEAR`）のみ
  で、どちらも「再 arm」の良性終了。分類（build-wait か真の停滞か等）は 100% `--stall-scan`
  に委譲するので健全な cold build を誤 wake しません。`dispatch_watch`（single、heavy
  producer 近接監視）を置換せず併走します。`runtime/driver/fleet_watch.lock`（winpid、
  W-024 stale-liveness 回収）で二重起動を拒否。PM 決定表（pm_field_manual §1 / pm_playbook
  §11）と ci.sh（`fleet_watch.test.sh`）に配線、対の worker 規約は worker_field_manual §5
  （節目で黙って turn を終えない — 常に register か進行 message / 走行中 background）(W-028)。

### Changed

- `merge_land.sh` argument UX (W-017). Landing a dispatch now takes the id the PM
  already has: `--dispatch-id <N>` (alias `--id`) resolves `--branch` from the
  dispatch container's checkout HEAD when the branch is omitted, `--guardian` /
  `--observer` are optional and read from the verdict marker
  (`runtime/<role>/results/<slug>-<role>.md`) via the gate's own fail-closed parser
  (a missing / placeholder / malformed marker yields no verdict — never an assumed
  PASS; an explicit flag always overrides), and every missing required input is
  validated once up front and reported together with usage instead of failing one
  arg at a time at submit. Fixes the live merge-chain friction where a PM hit
  `--branch required`, then `--guardian required`, one at a time (3 failed attempts,
  2026-07-06). / `merge_land.sh` の引数 UX 改善 (W-017)。dispatch の landing は PM が
  既に持つ id で完結する: `--dispatch-id <N>`（alias `--id`）が `--branch` 省略時に
  dispatch container の checkout HEAD から branch を解決し、`--guardian` / `--observer`
  は省略可で verdict marker (`runtime/<role>/results/<slug>-<role>.md`) を gate と同じ
  fail-closed parser で読み（marker 不在 / placeholder / 誤記は「verdict なし」= PASS を
  仮定しない。明示 flag は常に上書き）、必須引数の不足は submit 前に一括検証して usage と共に
  報告する（従来の submit 段階で 1 個ずつ判明する方式を廃止）。`--branch required` →
  `--guardian required` と 1 個ずつ失敗していた実摩擦 (2026-07-06、3 回失敗) を解消します。

### Fixed

- `heavy_compile_lock` — two defects that stalled a docs-only merge gate ~90 min
  (W-024). (a) **Idle stale-reclaim**: a holder that goes idle (a BLOCKED worker /
  the pid-0 Dock hold) kept its slot for the full `lease_minutes` (240), blocking
  every waiter. A waiter now reclaims a slot older than the new `stale_minutes`
  (default 30) whose owner is not a live pid AND runs zero cargo/rustc processes,
  writing an audit line to `runtime/locks/heavy_compile/reclaim.log`; a live owner
  pid or an in-flight compile (the `cargo` parent stays up, so the count never
  reads 0) is never idle-reclaimed, and the hard `lease_minutes` backstop is
  unchanged. The merge gate now records a Windows-checkable owner pid so the
  liveness check works there too. (b) **Data-only gates skip the lock**: a merge
  whose diff classifies `gate_mode=data_only` (`[merge_gate] data_only_paths`)
  runs the cheap `data_only_commands`, not a heavy build, so it no longer queues
  behind the heavy-compile lock. / `heavy_compile_lock` — docs-only の merge gate を
  約 90 分停滞させた 2 欠陥の是正 (W-024)。(a) **idle stale 回収**: idle 化した holder
  （BLOCKED worker / pid-0 の Dock hold）が `lease_minutes`（240）満了まで slot を保持し、
  待機側を全部塞いでいた。新 `stale_minutes`（既定 30）を超過し owner が live pid でなく
  cargo/rustc プロセス 0 本の slot を待機側が回収し、`runtime/locks/heavy_compile/reclaim.log`
  に監査行を残す。live な owner pid や compile 実行中（`cargo` 親が生存するので count が 0 に
  ならない）は idle 回収せず、hard な `lease_minutes` backstop は不変。merge gate は Windows で
  検査可能な owner pid を記録するようにし、liveness 検査が Windows でも効くようにした。
  (b) **data-only gate は lock を取らない**: diff が `gate_mode=data_only`
  （`[merge_gate] data_only_paths`）と判定される merge は heavy build でなく安価な
  `data_only_commands` を走らせるので、heavy-compile lock の後ろに並ばなくなった。
- `merge_land.sh` — the Guardian/Observer verdict auto-read silently misfired under
  a relative `--project` (e.g. `--project .`, which the PM commonly uses), reporting
  "Guardian verdict required" when the marker was right there — three consecutive
  land failures on 2026-07-07 (W-027). `read_marker_verdict` `cd`'d into the parser
  directory and only THEN read the marker, so a relative marker path resolved against
  the wrong directory and `ENOENT`'d, an error swallowed by `2>/dev/null`. It now
  `cat`s the marker in the caller's cwd and pipes the contents to the parser over
  stdin, so the path never crosses the `cd` (and no MSYS→Windows path translation is
  needed for it). It also now distinguishes an ABSENT marker (run the gate) from a
  PRESENT-but-MALFORMED one (fix the token) on stderr and in the pre-validation
  summary, since a prose/bold/`{{…}}` verdict reads as no-verdict and silently blocks
  the land. The verdict-marker contract in `attended-gate-dispatch.md` and
  `pm_field_manual.md` now states explicitly that the line under `## Verdict` must be
  a bare token — no bold, prose, or unfilled menu. / `merge_land.sh` — Guardian/
  Observer verdict の auto-read が相対 `--project`（PM が多用する `--project .` 等）で
  無言に誤動作し、marker が実在するのに「Guardian verdict required」を出していた
  （2026-07-07 に land 3 連敗、W-027）。`read_marker_verdict` が parser dir へ `cd`
  してから marker を読むため、相対 marker path が別 dir 基準に解決されて `ENOENT`
  （`2>/dev/null` で不可視）。呼び出し元 cwd で marker を `cat` し内容を stdin で parser
  に渡すようにし、path が `cd` を跨がない（MSYS→Windows path 変換も不要）ようにした。
  併せて marker **不在**（gate を回す）と **在るが malformed**（token を直す）を stderr と
  pre-validation summary で区別表示（prose/bold/`{{…}}` の verdict は no-verdict と読まれ
  land を無言に止めるため）。`attended-gate-dispatch.md` と `pm_field_manual.md` の
  verdict-marker 契約に「`## Verdict` 直下は素の token 1 行（bold/prose/menu 不可）」を明記。

### Dispatch metadata (W-019/020/021)

- Register text is now the canonical completion record; `dispatch_cleanup.sh
  --report-from-file` transcribes it into report.md at archive time. Gate agents
  receive the canonical verdict marker path + template via dispatch_prepare /
  context_pack (`gate_agents.*.verdict_template`). `--record-touches` writes
  measured base..HEAD paths to `task.touches_actual` without overwriting declared
  touches. / register 本文を完了記録の正本とし、`dispatch_cleanup.sh
  --report-from-file` が archive 時に report.md へ転写します。gate 役へは正準
  verdict marker path + template を dispatch_prepare / context_pack が配布
  (`gate_agents.*.verdict_template`)。`--record-touches` は実測 path を
  `task.touches_actual` に記録します (宣言 touches は不変) (W-019/020/021)。

## [2.10.0] - 2026-07-06

Self-driving dispatch reliability and merge-gate hardening release (W-030..W-096).
This release makes the attended/autonomous dispatch loop watch itself, drains the
merge gate without operator babysitting, mechanizes RAM- and token-budget
discipline, tightens instruction/doc hygiene, and generalizes the shipped skills of
dogfooding project names ahead of a public release. No breaking changes — every
addition and fix is backward compatible. / 自走 dispatch の信頼性と merge-gate 強靭化
リリース (W-030..W-096)。dispatch ループが自己監視し、merge gate を operator の
手離しで drain し、RAM・token 予算規律を機械化し、指示・文書衛生を固め、公開に向けて
同梱 skills から dogfooding project 固有名を一般化しました。破壊的変更なし —
追加・修正はすべて後方互換です。

### Self-driving dispatch health / 自走 dispatch の健全性監視

- A single reactive stall watchdog (`dispatch_watch.sh`, single + `--fleet`)
  classifies producer health with one taxonomy (PROGRESS / BUILDING / STALLED /
  RUNAWAY / REVIVE-NEEDED / UNWATCHED / UNPROCESSED-RESULT), auto-arms at dispatch,
  batches windows via `--windows N`, and guards over-budget watch+wake jobs; a
  register-terminate rule makes a producer's final turn an explicit completion
  signal (W-071, W-072, W-077, W-085, W-086, W-094). / 単一の反応型 stall watchdog
  (`dispatch_watch.sh`、single + `--fleet`) が producer 健全性を統一 taxonomy
  (PROGRESS / BUILDING / STALLED / RUNAWAY / REVIVE-NEEDED / UNWATCHED /
  UNPROCESSED-RESULT) で分類し、dispatch 時に自動 arm、`--windows N` で window を
  まとめ、予算超過の watch+wake job を guard します。register 終端規則で producer の
  最終ターンを明示的な完了シグナルにしました (W-071, W-072, W-077, W-085, W-086, W-094)。

### Merge-gate hardening / merge-gate の強靭化

- The async merge gate now spawns fully detached (no submit-side collateral kill),
  folds submit→wait→cleanup→pull into one `merge_land` macro (with `--close-row`),
  keeps poll stdout pure JSON (Logger writes to stderr), symmetrically finalizes a
  forgotten REPORTING gate, binds an Observer verdict to its review SHA, adds an
  opt-in adversarial refuter layer, and caps per-file gate-log bytes (W-030, W-062,
  W-066, W-073, W-079, W-087, W-088, W-091, W-093). / 非同期 merge gate を完全 detach
  spawn 化 (submit 側巻き添え死を根絶)、submit→wait→cleanup→pull を `merge_land` macro
  (+`--close-row`) に集約、poll stdout を純 JSON に維持 (Logger は stderr へ)、放置
  REPORTING gate を対称に finalize、Observer verdict を review SHA に束縛、opt-in の
  敵対 refuter 層を追加、per-file gate-log を byte cap しました (W-030, W-062, W-066,
  W-073, W-079, W-087, W-088, W-091, W-093)。

### RAM & token budgets / RAM・token 予算

- A RAM-budget build-lease gates concurrent heavy builds by free memory, the worker
  self-gate is scoped to the touched cargo crates (`--touches` → `cargo -p <pkg>`)
  so producers parallelize without OOM, and a quantified token audit trims
  duplicated hot-rules across the docs (W-030, W-068, W-070). / RAM 予算 build-lease
  が空きメモリで並行 heavy build を絞り、worker self-gate を触った cargo crate に
  scope 化 (`--touches` → `cargo -p <pkg>`) して producer を OOM なしに並列化、定量
  token 監査で docs 間の重複 hot-rules を削減しました (W-030, W-068, W-070)。

### Instruction & doc discipline / 指示・文書規律

- A dispatch-home instruction ledger (`instructions.md`, with an
  UNCONSUMED-INSTRUCTIONS check) closes the "scope-add message crosses the
  completion register" class, `dispatch_prepare` emits a ready-to-use prompt
  preamble, `context_pack` verifies `--touches` against `cargo metadata` (correct /
  keep-unverified / skip), and hot-rule indices (§0) plus a documented harness-limits
  §6 keep guidance reachable and slim (W-078, W-084, W-089, W-090, W-092, W-095). /
  dispatch home の指示台帳 (`instructions.md`、UNCONSUMED-INSTRUCTIONS 検出) が
  「scope 追加 message が完了 register と交差する」class を塞ぎ、`dispatch_prepare` が
  即用の prompt preamble を emit、`context_pack` が `--touches` を `cargo metadata` で
  検証 (補正 / 未検証保持 / skip)、hot-rule index (§0) と harness 実行限界 §6 で
  guidance を reachable かつ slim に保ちます (W-078, W-084, W-089, W-090, W-092, W-095)。

### Worker safety, hygiene & release prep / worker 保全・衛生・公開準備

- `worker_finalize` bundles gate→commit→report, `workspace_isolate --collect`
  refuses a dirty worktree (no silent work loss), a reverse-reachability lint fails
  orphan docs in CI, the `[guardian_tools].secret_scan` default moves off the
  deprecated `gitleaks detect` verb to `gitleaks dir` (W-083), the README was
  reworked, and the shipped skills/docs were generalized of dogfooding project names
  for a public release (W-069, W-074, W-080, W-081, W-083, W-096). / `worker_finalize`
  が gate→commit→report を束ね、`workspace_isolate --collect` が dirty worktree を拒否
  (作業の無言消失を防止)、逆 reachability lint が orphan doc を CI で fail、
  `[guardian_tools].secret_scan` 既定を deprecated な `gitleaks detect` verb から
  `gitleaks dir` へ移行 (W-083)、README を再構成し、公開に向けて同梱 skills/docs から
  dogfooding project 固有名を一般化しました (W-069, W-074, W-080, W-081, W-083, W-096)。

## [2.9.5] - 2026-07-03

Attended-dispatch reliability and merge-gate efficiency release (W-022..W-038).
Garelier now mechanizes more of the attended workflow around dispatch health,
model routing, gate retry/skip policy, stall escalation, and merge-gate
retention, while reducing operator-visible token noise. / attended dispatch の
信頼性と merge-gate 効率化リリース (W-022..W-038)。dispatch health、model
routing、gate retry/skip policy、stall escalation、merge-gate retention をより
機械化し、operator に見える token noise も削減しました。

### Added

- `contract_check.ts` adds attended-dispatch contract checks for idle producers
  or gates without artifacts, stall scanning that distinguishes build-wait from a
  real stall, and escalation stages from nudge to handoff. / `contract_check.ts`
  が、artifact なしで idle になった producer/gate の検出、build-wait と実 stall の
  区別、nudge から handoff への escalation stage を追加しました。
- Model/effort routing is now mechanized for dispatch, including an above-PM
  escalation ceiling and advisory warnings when a Worker gate is weaker than the
  producer path. / dispatch の model/effort routing を機械化し、PM より上位 model
  への escalation ceiling と、Worker gate が producer path より弱い場合の advisory
  warning を追加しました。
- Merge gate now supports preflight fail-fast, opt-in transient-failure retry,
  a data-only fast path, and documented mechanical-delta re-gate policy. / merge
  gate に preflight fail-fast、opt-in transient-failure retry、data-only fast
  path、mechanical-delta re-gate policy を追加しました。
- Lightweight producer isolation for control-only repos and attended-mode
  Guardian/Observer gate dispatch guidance were added, with jig templates wired
  to the attended parity features. / control-only repo 向け lightweight producer
  isolation と attended-mode Guardian/Observer gate dispatch guidance を追加し、
  jig template を attended parity features に結線しました。

### Changed

- Merge-gate poll/status output now summarizes `results/` and `pending/` counts
  instead of emitting noisy per-file lists, and role skill frontmatter
  descriptions were compressed to reduce prompt surface. / merge-gate poll/status
  は `results/` と `pending/` を件数 summary にし、role skill frontmatter
  description も圧縮して prompt surface を削減しました。
- Stall handling now treats backgrounding as a harness fact rather than a
  recoverable shortcut, and Worker guidance asks long builds to send progress
  messages. / stall handling は backgrounding を recoverable shortcut ではなく
  harness fact として扱い、Worker guidance は長い build 中の progress message を
  明示しました。
- Merge-gate retention now prunes `results/` at write time and implements the
  documented day-based `archive/` retention. / merge-gate retention は `results/`
  を write 時に prune し、文書化済みの day-based `archive/` retention を実装しました。

### Fixed

- The G-15 stale-verdict guard now has a tree-hash fallback for mechanical deltas,
  and unknown-argument errors now print valid flags. / G-15 stale-verdict guard
  に mechanical delta 向け tree-hash fallback を追加し、unknown-argument error が
  valid flags を表示するようにしました。
- Task mirror reachability and drift protection were tightened so the mirror
  remains a derived view of canonical backlog/dispatch state. / task mirror の
  reachability と drift protection を強化し、canonical backlog/dispatch state からの
  derived view として維持します。

## [2.9.4] - 2026-06-30

Windows merge-gate stale-lock fix. Garelier now releases `active.lock` after a
completed merge gate by matching the lock's `request_id` instead of comparing
process IDs across Windows and Git Bash namespaces. / Windows の merge-gate
stale-lock 修正。完了した merge gate 後の `active.lock` 解放を、Windows と Git Bash
で異なる process ID namespace に依存せず、lock の `request_id` 一致で行うように
しました。

### Fixed

- `merge-gate.sh` no longer leaks `runtime/merge_gate/locks/active.lock` after
  successful or early-exit completion on Windows + Git Bash when the lock was
  written by the TypeScript driver with a Windows PID but the shell script saw a
  different MSYS PID. Dispatch-native operation now self-releases the gate lock
  without depending on a driver poll backstop. / Windows + Git Bash で、
  TypeScript driver が Windows PID を書き、shell script 側の `$$` が別の MSYS PID
  になるため、完了後も `runtime/merge_gate/locks/active.lock` が残る問題を修正。
  dispatch-native 運用でも driver poll の backstop に依存せず gate lock を自己解放します。

## [2.9.3] - 2026-06-29

Build-stall prevention + live backlog visibility (DEC-091 / DEC-092).
Garelier now gives sub-agent producers a safer heavy-build path, exposes a
scripted backlog-to-session task mirror for PM progress visibility, improves the
Status Web knowledge/docs experience, expands Lens defaults, and removes
project-specific wording from shipped framework artifacts. / build-stall 防止 +
live backlog 可視化 (DEC-091 / DEC-092)。sub-agent producer の重い build 経路を
安全化し、PM 進捗を見せる scripted backlog-to-session task mirror を追加し、
Status Web の knowledge/docs 表示、Lens defaults、公開 framework artifact の
project-specific 表現を改善しました。

### Added

- Build-stall prevention for sub-agent dispatch (DEC-091): produce prompts and
  Worker guidance now keep producer self-gates foreground-friendly by warming
  heavy caches from the attended main session, scoping producer checks to touched
  crates/files, and requiring a clean BLOCK instead of detach-and-idle when a
  scoped gate still exceeds the foreground budget. / sub-agent dispatch の
  build-stall 防止(DEC-091): produce prompt と Worker guidance が、main session で
  heavy cache を warm し、producer check を touched crate/file に絞り、なお foreground
  budget を超える場合は detach-and-idle ではなく clean BLOCK させるようになりました。
- `dispatch_watch.sh` and `doctor` stranded-producer detection provide a
  reactive backstop for stalled producer residue while keeping the preventive
  path primary. / `dispatch_watch.sh` と `doctor` の stranded-producer 検出を追加し、
  予防を primary にしたまま stall residue を発見できる backstop を用意しました。
- Backlog → harness Task-list mirror (DEC-092): `task_mirror.ts` derives
  markdown/json/ops views from the canonical backlog plus live dispatch state,
  and PM runtime guidance points status queries and multi-item drains at that
  scripted mirror. / backlog → harness Task-list mirror (DEC-092): `task_mirror.ts`
  が canonical backlog と live dispatch state から markdown/json/ops view を生成し、
  PM runtime guidance が status query と multi-item drain でこの scripted mirror を
  使うようになりました。
- Status Web now includes a Guide tab backed by new `using_garelier` docs and a
  Knowledge → Lens tab showing lens packs, roles, groups, status, labels, and
  defaults. / Status Web に新しい `using_garelier` docs を使う Guide tab と、lens
  pack/role/group/status/label/default を表示する Knowledge → Lens tab を追加しました。
- Lens defaults gained reuse-first, robustness, over-engineering, and
  adversarial-persona focus groups with new Worker/Artisan/Observer/Smith packs.
  / Lens defaults に reuse-first、robustness、over-engineering、
  adversarial-persona focus groups と Worker/Artisan/Observer/Smith packs を追加しました。

### Changed

- Status Web queue, knowledge, source, routine, and docs views were refined for
  clickable tables, modal file viewing, stable columns, cleaner tab labels, and
  better wrapped-list rendering. / Status Web の queue / knowledge / source /
  routine / docs view を、clickable table、modal file viewer、stable column、
  より整理された tab label、wrapped-list rendering に改善しました。
- Public-facing docs and templates were de-contaminated from target-project
  specifics, retired PowerShell references, stale script names, and internal
  comment-like clutter. / 公開 docs と template から target-project 固有語、
  retired PowerShell reference、古い script 名、内部 comment 風の clutter を除去しました。

## [2.9.2] - 2026-06-29

Dispatch safety + gate-role boundary hardening (DEC-089 / DEC-090). Garelier now
refuses duplicate in-flight dispatches by slug, keeps gate verdicts owned by
gate-role agents, wires knowledge reachability for the new boundary rules, and
cleans up control/status UI drift. / Dispatch 安全性 + gate-role 境界強化
(DEC-089 / DEC-090)。同一 slug の in-flight dispatch 重複を拒否し、gate verdict
を gate-role agent の成果物として維持し、新しい境界ルールの knowledge reachability
を結線し、control/status UI drift を修正しました。

### Fixed

- Status Web Control → Artifacts: a control node whose `status` is long prose
  (e.g. a blueprint `Status:` line carrying a paragraph) was rendered as a single
  `white-space: nowrap` chip, stretching the status column and hiding the other
  columns. The status cell now shows a short leading label with the full text on
  hover (`title`), plus a `td .chip` width cap as a safety net. / Status Web の
  Control → Artifacts で、`status` が長い prose の control node が nowrap chip と
  して描画され status 列が広がり他列が見えなくなる不具合を修正。短い先頭ラベル +
  hover で全文表示、table cell chip に width cap を追加。

### Added

- Blueprint `Status` vocabulary is now enforced (warn-first) by the control graph
  validator, alongside the existing milestone / decision / backlog vocabularies
  (DEC-047): a blueprint Status that is not one of `draft | active | paused |
  shipped | archived` raises `blueprint-status-vocab` so rationale / SHAs / dates
  stay in the body, not the Status field. / blueprint の `Status` 語彙を control
  graph validator が warn-first で強制(milestone/decision/backlog と同様、DEC-047):
  `draft | active | paused | shipped | archived` 以外は `blueprint-status-vocab`
  で警告し、rationale/SHA/日付を Status 欄でなく body に置くよう促す。

- Duplicate in-flight dispatch guard (DEC-089): `dispatch_prepare` refuses to
  produce a slug that already has a live in-flight `_dispatch<N>` container
  (`--force` for a deliberate parallel), and `doctor` flags two or more in-flight
  dispatches that share a slug. The branch name carries the id, so a duplicate
  produce was otherwise silent (a `REPORTING` dispatch could be re-produced by the
  jig full-tick). / 同一 slug 二重 dispatch ガード (DEC-089): `dispatch_prepare` が
  既に in-flight な slug の再 produce を拒否（`--force` で意図的並行）、`doctor` が
  同一 slug の in-flight `_dispatch<N>` 2 件以上を検出。branch 名が id を含むため
  二重 produce は従来サイレントだった（REPORTING を jig full-tick が再 produce し得た）。

- Gate-role verdict boundary and held-branch re-gate path (DEC-090):
  PM/Dock are explicitly prevented from substituting their own verification for
  Guardian / Observer / Smith verdicts; held or reworked branches re-gate through
  `jig_gate_held`, and the Librarian knowledge index now gives those boundary
  rules a narrow reachability trigger instead of bloating `read_first`. /
  gate-role verdict 境界と held branch re-gate 経路を追加(DEC-090): PM/Dock が
  Guardian / Observer / Smith verdict の代わりに自分で検証したことにするのを禁止し、
  held/reworked branch は `jig_gate_held` で再 gate。Librarian knowledge index は
  `read_first` を膨らませず、狭い reachability trigger で境界ルールを読ませます。

## [2.9.1] - 2026-06-28

Route-bypass hardening + Git Bash only script surface (DEC-087 / DEC-088).
Garelier closes a class of "a canonical structural path exists but is bypassable
by hand with no preventive or detective control" gaps in dispatch and
integration, and completes the move to a single Git Bash script surface. /
経路バイパス対策 + Git Bash 一本化 (DEC-087 / DEC-088)。dispatch / integration に
おける「正準の構造的経路があるのに preventive も detective も無く hand-roll で迂回でき
る」gap の class を塞ぎ、スクリプト面を Git Bash に一本化しました。

### Changed

- Retired shipped PowerShell helper twins and the PowerShell dispatcher, and
  removed the `install.ps1` install path. Windows operation is documented as Git
  Bash based (`install.sh` + helpers from Git Bash), while helper implementation
  continues moving toward TypeScript-first logic. / PowerShell 版 helper と
  PowerShell dispatcher を撤去し、`install.ps1` install 経路も削除しました。Windows
  運用は Git Bash 前提(`install.sh` と helper を Git Bash から実行)に統一し、helper
  実装は引き続き TypeScript-first へ移行します。

### Added

- Producer dispatch now emits the canonical agent `label` (`produce:<slug>`) and
  `name` (`<role>(#<id>)`), and `role_subagent_dispatch.md` §5 + the Dock skill
  require commit-bearing producers to launch via `dispatch_prepare`/jig (a bare
  Agent/Task is for read-only roles only). / producer 起動が正準 `label`
  (`produce:<slug>`) と `name` (`<role>(#<id>)`) を emit し、commit を産む producer
  は `dispatch_prepare`/jig 経由起動を必須化(bare Agent/Task は read-only role のみ)。
- `doctor` gains a dispatch/runtime state-integrity section: orphan
  `_dispatch<N>` containers, containers launched outside `dispatch_prepare`,
  durable content parked in the transient `runtime/manifest.md`, and an unbounded
  `events.jsonl` become warn-first findings. / `doctor` に dispatch/runtime 整合
  検査を追加(orphan container / dispatch_prepare 外起動 / manifest への永続内容混入 /
  events.jsonl 肥大 を warn 検出)。
- An OPT-IN main-worktree git-hook bundle (`garelier install-main-guards`): a
  producer-on-studio commit guard, a `pre-rebase` guard for studio/garelier
  branches, and an opt-in target-push promote guard. Hooks are never
  auto-installed, preserving clean removability. / OPT-IN な main-worktree git
  hook bundle(`garelier install-main-guards`): producer の studio commit guard、
  studio/garelier の `pre-rebase` guard、opt-in の target-push promote guard。
  hook は自動 install せず removability を維持。
- `dispatch_event.sh` size-caps `runtime/dispatch/events.jsonl` with rotation. /
  `dispatch_event.sh` が `events.jsonl` を size-cap rotation。

### Security

- The merge gate binds the Guardian/Observer verdict to a real review report:
  `merge_request.sh` can emit `guardian_report_path` + `guardian_review_sha`, and
  the opt-in `[guardian_policy]/[observer_policy] require_report` makes an
  asserted `--guardian PASS` with no backing report fail the gate, closing a
  security-gate-skip bypass. / merge gate が Guardian/Observer verdict を実 review
  report に結線。`merge_request.sh` が `guardian_report_path` + `guardian_review_sha`
  を emit でき、opt-in `require_report` で report 無しの `--guardian PASS` を gate
  失敗に(security gate 素通りを封鎖)。

## [2.9.0] - 2026-06-28

Plant / Crust / Lens release (DEC-085 / DEC-086): Garelier can now manage
external working trees through minimal Crust configuration and container locks,
PM can operate cross-container with one launch point, and roles gain Lens packs
plus smaller first-read surfaces. / Plant / Crust / Lens リリース (DEC-085 /
DEC-086): 最小 Crust 設定と container lock で外部作業ツリーを管理でき、PM は
1 つの起動点から cross-container に運用できます。各ロールには Lens pack とより小さい
first-read surface を追加しました。

### Added

- Plant / Crust setup support, including `crust_init.{sh,ps1}`,
  `crust.toml`, `container.lock.toml`, `.gitignore` defaults, and doctor/status
  awareness for external containers. / Plant / Crust セットアップ対応を追加。
  `crust_init.{sh,ps1}`、`crust.toml`、`container.lock.toml`、`.gitignore`
  既定、外部 container を見る doctor/status を含みます。
- Lens registry and per-role Lens packs for PM, Dock, Worker, Scout, Smith,
  Artisan, Librarian, Observer, Guardian, Concierge, and Wanderer. / 全ロール向け
  Lens registry と Lens pack を追加しました。
- Public docs for Plant-Crust and Lens concepts in English and Japanese. /
  Plant-Crust と Lens の公開 docs を日英で追加しました。

### Changed

- Crust configuration is intentionally minimal; durable container details live
  in `container.lock.toml` so users can add or remove containers without editing
  a large config file. / `crust.toml` は最小化し、永続 container 詳細は
  `container.lock.toml` に寄せました。
- PM, Dock, Artisan, Concierge, Guardian, Librarian, Observer, Scout, Smith,
  Wanderer, and Worker role docs now point to smaller topic-specific references,
  reducing default first-read token cost while keeping compatibility index files.
  / 各ロール docs を小さい topic 別 reference へ分割し、互換 index を残したまま
  既定 first-read の token cost を削減しました。
- Release runbooks now document `gh release` draft/publish steps and the final
  return to the assigned working branch after public release publication. /
  release runbook に `gh release` の draft/publish 手順と、公開後に指定作業
  branch へ戻す手順を追加しました。

### Fixed

- Split reference paths were audited and corrected after the role-doc diet so
  nested PM/Dock/Worker/Artisan references resolve consistently. / role-doc
  分割後の nested reference path を監査・修正しました。

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
