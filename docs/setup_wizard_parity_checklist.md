# Setup Wizard Parity Checklist / setup wizard パリティ確認

> Purpose: keep `setup_wizard.sh` and `setup_wizard.ps1` behaviorally
> equivalent. Run this checklist whenever either wizard changes.

このチェックリストは、bash 版と PowerShell 版の setup wizard が同じ入力で
同じ Garelier レイアウトを生成することを確認するための手順です。

## 1. Static Checks

- `bash -n skills/garelier-pm/scripts/setup_wizard.sh` が通る。
- `pwsh -NoLogo -NonInteractive -Command '$null = [scriptblock]::Create((Get-Content -Raw skills/garelier-pm/scripts/setup_wizard.ps1))'` が通る。
- help 出力に fresh / diff / migrate の必須引数、`--target` / `-Target`,
  `--pm-id` / `-PmId`, deprecated alias `--base` / `-Base`,
  `--smiths` / `-Smiths`, `--librarians` / `-Librarians`,
  `--observers` / `-Observers`, `--artisan` / `-Artisan`,
  `--no-artisan` / `-NoArtisan`,
  `--default-lane` / `-DefaultLane`,
  `--skip-confirm` / `-SkipConfirm`,
  `--install-tools` / `-InstallTools`,
  `--allow-requeued-removal` / `-AllowRequeuedRemoval` が両方載っている。
- 追加・変更した option は bash と PowerShell の両方に存在する。
- Tool setup preflight は bash / PowerShell で同じ:
  missing Bun / driver dependencies / offline Mermaid bundle / Guardian
  gitleaks を検出し、interactive では確認、non-interactive では
  `--install-tools` / `-InstallTools` が無い限り exit 3、
  `--skip-confirm` / `-SkipConfirm` では外部 tool を暗黙 install せず継続。
- `{{placeholder}}` が生成済みファイルへ漏れていない（`{{pm_id}}` を
  含む）。

## 2. Fresh Mode Layout

同じ starting state から bash 版と PowerShell 版を別々の一時 repo で実行し、
以下が一致することを確認します。Fresh は `__garelier/` ディレクトリで
実行します（v2.0 以前は `__garelier/_pm/` で実行していたが、v2.1 で
変更）。

Example input:

```text
project name: Parity Smoke
pm id: acme
target: main
workers: worker-01:claude-code,worker-02:codex-cli:gpt-5-codex
scouts: scout-01:claude-code
smiths: smith-01:codex-cli:gpt-5-codex
scout idle task: false
skip confirm: true
```

Expected:

- `garelier/main/acme/studio` が作成され、primary checkout がその
  branch にいる（branch 名に `<pm_id>` が埋め込まれることを確認）。
- `__garelier/<pm_id>/control/` が生成される。
- `__garelier/<pm_id>/runtime/` が生成される。
- **DEC-036 in-project（既定）**: 各 worktree-role の container は **プロジェクト内**
  `__garelier/<pm_id>/_<role>/<id>/` に作られ、git worktree はその `checkout/` に
  ある。`runtime/workspace_paths` ポインタは **生成されない**（既定）。両 wizard
  とも同形を生成すること（GARELIER_HOME / `--exile`/`-Exile` を渡さずに比較）。
- 各 role の `checkout/.claude/settings.local.json` に `claudeMdExcludes` が書かれ、
  本流 `<absproj>/CLAUDE.md` / `<absproj>/.claude/CLAUDE.md` /
  `<absproj>/.claude/rules/**` の絶対 glob が入る。worktree の `info/exclude` に
  `.claude/settings.local.json` が追加され、untracked リークしない。
- 各 role の container（checkout の親）に `STATE.md`、`CLAUDE.md` があり、`CLAUDE.md`
  に `PM identifier: acme` 行 + Primary checkout / Runtime directory / Control
  directory の **絶対パス**（in-project でも exile でも有効）が記載されている。
- **exile opt-in**（`--exile`/`-Exile` または `GARELIER_HOME`）の場合のみ:
  container は **プロジェクト外** の machine-local home
  `$GARELIER_HOME/<home_id>/_<role>/<id>/`（`home_id` =
  `<basename>-<sha1(abs git-dir)[:8]>-acme`）になり、in-proj の `_workers/` 等は
  リークしない。`runtime/workspace_paths` に `<role-singular>.<id>=<abs container>`
  が各 1 行ずつ入り、各値は **native 絶対パス**（`C:/...`、MSYS `/c/...` ではない）。
  ポインタが指す container に `checkout/.git`・`STATE.md`・`CLAUDE.md` があり、
  `git worktree list`（native path）と一致する。
- `__garelier/<pm_id>/_pm/setup_config.toml` の `[pm]` セクションに
  `pm_id = "acme"` が入る。
- `__garelier/<pm_id>/_pm/setup_config.toml` の `[branches]` に `target`,
  `target_slug`, `integration` が入り、`integration` の値が
  `garelier/main/acme/studio` になっている。
- `__garelier/<pm_id>/_pm/setup_config.toml` に `[runner]` があり、
  `pm_provider`, `dock_provider`, `default_agent_provider` が入る。
- 各 `[[workers]]` / `[[scouts]]` / `[[smiths]]` ブロックに `provider`, `model`,
  commented `# effort = "xhigh"` が入る。
- `__garelier/<pm_id>/_pm/setup_config.toml` に `[retention]` があり、
  `history_hot_entries = 120` など `retention.md` の default が入る。
- `__garelier/<pm_id>/_pm/setup_config.toml` に `[concurrency]`（DEC-027 / DEC-031）が
  あり、`max_concurrent_agents = 4` / 優先度 `tiers`（gates / smith+librarian /
  worker+scout+artisan / 空の降格ティア の配列の配列）/ `starvation_cycles = 3`
  が入る。diff / migrate mode では欠落時のみ追補され、既存値は保持される。
- `__garelier/<pm_id>/_pm/setup_config.toml` に `[lanes]`（DEC-056）があり、既定で
  `default = "dock"`。`--default-lane artisan` / `-DefaultLane artisan`（fresh のみ）
  を渡したときだけ `default = "artisan"` になる。diff / migrate では欠落時のみ
  `default = "dock"` を追補（`--default-lane` を fresh 以外で渡すと両 wizard とも
  エラー終了）。両 wizard が同形を生成する。
- `__garelier/<pm_id>/_pm/history/archive/` と
  `__garelier/<pm_id>/runtime/backlog/archive/` が存在する。
- `__garelier/<pm_id>/_pm/history.md` に setup entry が 1 件ある。
- `__garelier/<pm_id>/runtime/manifest.md` の Worker / Scout / Smith 表が入力と一致する。
  `PM: acme` の行と `Smith hardening targets remaining: 0` も入る。
- DEC-051: ネストした `__garelier/.gitignore` が `runtime_gitignore` 内容で
  書かれる（`__garelier/` 相対なので `*/runtime/` などの glob）。
  `__garelier/.ignore` も `search_ignore` 内容で書かれる。
  **プロジェクト root の `.gitignore`/`.ignore` は触らない**(あれば legacy
  block のみ除去)。`git check-ignore __garelier/<pm_id>/runtime` が ignore 判定になる。
- `__garelier/<pm_id>/control/project_dashboard/`, `operations/`,
  `delegation/`, `request_intake/`, `scheduled_jobs/`, `reports/`
  が存在する。
- `__garelier/<pm_id>/_pm/setup_config.toml` の末尾に `[setup]` セクションが
  存在し、`complete = true`, `completed_at = "..."`,
  `wizard_version = "2.7.0"` の3行が入る（fresh mode 完走の証拠）。
- `__garelier/<pm_id>/_pm/.claude/settings.json` が存在し、`SessionStart`
  フックが `session_digest.sh` を呼ぶ（トークン消費ゼロの状態ダイジェスト）。
  driver 停止用の `SessionEnd` フックは生成しない（DEC-066 — driver 削除に
  伴い撤去。`.sh`/`.ps1` 両系統で同一）。

### 2.1 pm_id プロンプト

- `--pm-id` / `-PmId` を渡さず interactively 実行すると、
  単一ユーザー向けデフォルト `_workshop` が提示される。共有・複数
  ユーザーのプロジェクトでは一意な `pm_id` を明示指定するよう案内する。
  空 enter で `_workshop` が採用される。
- `--skip-confirm` / `-SkipConfirm` のときは、`--pm-id` 未指定なら
  自動で `_workshop` が採用される。
- `_workshop` または pm_id 形式
  `[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?` を満たさない値は両方の wizard
  でリジェクトされる。
- 既に `__garelier/<pm_id>/` が存在し完走済みの場合、両方とも
  「`Use --mode diff` from `__garelier/<pm_id>/_pm/`」を案内して exit 1。

## 3. Diff Mode Add / Remove

fresh mode で作った repo から、以下を順に確認します。Diff は
`__garelier/<pm_id>/_pm/` ディレクトリで実行します。pm_id は cwd の
親ディレクトリ名から自動検出されます（明示で `--pm-id` を渡しても
cwd と一致しなければ失敗）。

### Add

Input:

```text
workers: worker-01:claude-code,worker-02:claude-code,worker-03:claude-code
scouts: scout-01:claude-code,scout-02:codex-cli:gpt-5-codex
smiths: smith-01:codex-cli:gpt-5-codex,smith-02:claude-code
```

Expected:

- `worker-03` Worker worktree が `__garelier/<pm_id>/_workers/worker-03/`
  として追加される。
- `scout-02` Scout worktree が `__garelier/<pm_id>/_scouts/scout-02/`
  として追加される。
- `smith-02` Smith worktree が `__garelier/<pm_id>/_smiths/smith-02/`
  として追加される。
- 既存 `worker-01`, `worker-02` Worker と `scout-01` Scout は保持される。
- `setup_config.toml`, `manifest.md`, `_pm/history.md` が更新される。
- 既存 agent の個別 `effort = "..."` は diff mode 後も保持される。

### Remove

すべての対象 agent の `STATE.md` が `IDLE` であることを確認してから、
入力から `worker-02` Worker、`scout-02` Scout、`smith-02` Smith を外します。

Expected:

- 対象 worktree が削除される。
- `setup_config.toml` と `manifest.md` から対象 agent が消える。
- `_pm/history.md` に setup-change entry が追加される。
- 残る agent は保持される。

### Remove after retire-and-requeue

対象 agent が non-IDLE の場合、通常は exit 2。PM が先に
retire-and-requeue を完了し、同じ task id を `pending.md` に戻して
`Outcome: requeued` を記録した場合だけ、
`--allow-requeued-removal` / `-AllowRequeuedRemoval` 付きで削除できる。
この flag 自体は backlog を編集しないことを確認する。

### Librarians / Observers / Artisan (DEC-017–0019)

Workers/Scouts/Smiths と同じ desired-set セマンティクスで Librarian
(`--librarians` / `-Librarians`) と Observer (`--observers` / `-Observers`)
を増減し、Artisan レーンを `--artisan` / `-Artisan` と
`--no-artisan` / `-NoArtisan` でトグルできることを確認します。fresh で
`--librarians lib1 --observers obs1 --artisan` を作った repo を起点に:

- `--librarians "lib2:..."` で `lib1` を外して `lib2` を渡すと、
  `__garelier/<pm_id>/_librarians/lib1` worktree が削除され `lib2` が追加され、
  `[[librarians]]` ブロックが入れ替わる。フラグ省略時は既存 Librarian を保持。
- `--observers ""` で全 Observer を削除でき、`--observers "obs9:..."` で追加できる。
  初回 Observer 追加時に `__garelier/<pm_id>/runtime/observer/{inbox,requests,results,locks}`
  と `__garelier/<pm_id>/control/observations/` が scaffold される。フラグ省略時は保持。
- `--no-artisan` / `-NoArtisan` で `[artisan].enabled = false` になり
  `__garelier/<pm_id>/_artisan` worktree が削除される。`--artisan` / `-Artisan`
  で `enabled = true` になり worktree が `<target>` から detach で再作成される。
  両方省略すると現在の artisan 状態は不変。
- 非 IDLE の Librarian/Observer 削除、および非 IDLE Artisan の `--no-artisan`
  無効化は exit 2 でブロックされる（Workers と同じガード）。
- 変更後の `setup_config.toml` が driver の `loadConfig` で期待どおり parse
  される（`librarians` / `observers` 配列、`artisan` の有無）。
- 同一入力で再実行すると `No changes required.` で exit 0（冪等）。

## 3.5 Migrate Mode (v2.0 → v2.1)

v2.0 flat layout (`__garelier/_pm/`, `__garelier/control/` などが
top-level にある) を持つテスト repo を用意し、`__garelier/` ディレクトリ
で `--mode migrate` / `-Mode Migrate` を実行して以下を確認します。

Example input:

```text
mode: migrate
pm id: acme
skip confirm: true
```

Expected:

- `__garelier/_pm/`         → `__garelier/<pm_id>/_pm/`         (git mv)
- `__garelier/_dock/`  → `__garelier/<pm_id>/_dock/`  (git mv)
- `__garelier/control/`     → `__garelier/<pm_id>/control/`     (git mv)
- `__garelier/_workers/<wid>/` → `__garelier/<pm_id>/_workers/<wid>/`
  (git worktree move; `git worktree list` が新パスを示すこと)
- `__garelier/_scouts/<sid>/`  → `__garelier/<pm_id>/_scouts/<sid>/`
  (git worktree move)
- `__garelier/_smiths/<sid>/`  → `__garelier/<pm_id>/_smiths/<sid>/`
  (git worktree move)
- **DEC-036 relocation フェーズ（双方向）**: `migrate` は exile opt-in シグナル
  （`--exile`/`-Exile`/`GARELIER_HOME`/`[workspace] home_root`）で向きを決める。
  **既定**は exile→in-proj へ巻き戻し（`runtime/workspace_paths` のエントリを
  反復、各 container を `git worktree move` で `__garelier/<pm_id>/_<role>/<id>/`
  へ、claudeMdExcludes を書き、ポインタ行を削除、空になったポインタファイルと
  exile container を掃除）。`--exile` 時は逆（in-proj→exile、ポインタ記録）。
  どちらも `STATE.md` 等の調整ファイル・workbench/anvil branch・HEAD を保持し、
  `git worktree move` 失敗時は SHA 退避 + `worktree add --detach` の cross-drive
  fallback。migrate gate は **tracked-only**（`git status --porcelain
  --untracked-files=no`）で、uncommitted な **tracked** 変更を持つ role のみ
  skip（commit 後に再実行で完了）。冪等。両 wizard が同形を生成すること。
- `__garelier/runtime/`     → `__garelier/<pm_id>/runtime/`     (plain mv;
  gitignored なので git は気にしない)
- branch `garelier/<slug>/studio` → `garelier/<slug>/acme/studio`
  (git branch -m)
- 全 `garelier/<slug>/workbench/*` branch → `garelier/<slug>/acme/workbench/*`
- 全 `garelier/<slug>/anvil/*` branch → `garelier/<slug>/acme/anvil/*`
- `__garelier/<pm_id>/_pm/setup_config.toml` に `[pm]` セクション
  (`pm_id = "acme"`) が挿入され、`integration` 値、`worktree` パス、
  `garelier_version`, `wizard_version` がそれぞれ v2.5 値に更新される。
- DEC-051: ネストした `__garelier/.gitignore` / `__garelier/.ignore` が
  (再)生成され、root `.gitignore`/`.ignore` に legacy block があれば除去される
  (= root を pristine に戻す)。root には新たな Garelier 行を足さない。
- 一切の `git push` が行われない（local-only ルール; protocol.md §6.5）。

Failure cases:

- 既に `__garelier/<pm_id>/` が存在する場合は exit 1。
- 新 studio branch `garelier/<slug>/<pm_id>/studio` が既に存在する場合は
  exit 1。
- `__garelier/_pm/setup_config.toml` が無いと「v2.0 layout detected
  されません」と言って exit 1。

## 4. Guarded Failure Cases

以下の失敗が bash と PowerShell で同じ意味になることを確認します。

- fresh mode を git repo 外で実行すると失敗する。
- commit が 0 件の repo で fresh mode を実行すると失敗する。
- 存在しない target branch を指定すると失敗する。
- 同じ `<pm_id>` で `[setup] complete = true` を含む既存
  `__garelier/<pm_id>/_pm/setup_config.toml` がある状態で fresh mode を
  実行すると失敗する（`Use --mode diff from __garelier/<pm_id>/_pm/`
  への誘導メッセージが出る）。別の `--pm-id` を渡せば成功する。
- legacy v1.x install（`[branches]` あり + `manifest.md` + `history.md`
  あり、ただし `[setup]` セクション無し）で同じ `<pm_id>` の fresh mode
  を実行すると同じく失敗する。
- 部分インストール（`__garelier/<pm_id>/` 配下に
  `{runtime,control,_pm,_dock,_workers,_scouts,_smiths}/`
  のどれかが存在するが `[setup] complete = true` 無し）
  で fresh mode を実行すると、検出された残骸を一覧表示して
  `Clean these up and continue with fresh init? [y/N]` を問う。
  - `y` を入れると worktree 削除 → studio branch
    (`garelier/<slug>/<pm_id>/studio`) 削除 → `__garelier/<pm_id>/`
    削除 → root `.gitignore` の legacy Garelier block 除去（最後の PM なら
    orphan の `__garelier/.gitignore`/`.ignore` も削除; DEC-051）→ fresh init 続行。
  - それ以外を入れると exit 1 で中断。
  - `--skip-confirm` / `-SkipConfirm` 付きの場合は確認無しで自動クリーンアップ。
- 違う PM (`__garelier/<other-pm>/`) の worktree や studio branch は
  partial cleanup の対象外（他人の PM を巻き込まない）。
- diff mode を `__garelier/<pm_id>/_pm/` 以外から実行すると失敗する。
- diff mode で `setup_config.toml` が無い場合は失敗する。
- diff mode で `__garelier/<pm_id>/runtime/` が無い場合は失敗する。
- diff mode で削除対象 agent が `IDLE` でない場合、exit code 2 で止まる。
- diff mode の target tracking merge が conflict した場合、exit code 3 で
  止まり、PM が conflict 解消後に再実行できる。
- migrate mode を v2.1 layout の repo で実行すると「no v2.0 layout
  detected」で exit 1。
- migrate mode で `<pm_id>` が衝突する場合（`__garelier/<pm_id>/` 既存、
  あるいは新 studio branch 既存）は exit 1。

## 5. Comparison Rules

完全な byte-for-byte diff は要求しません。timestamp、path separator、
PowerShell と bash の表示文言は差分になり得ます。比較対象は以下です。

- directory tree shape
- git branch / worktree topology
- `setup_config.toml` semantic content
- `manifest.md` table content
- seeded control scaffold file set
- role `CLAUDE.md` contents
- history entry count and outcome type
- exit code and guarded failure meaning

## 6. Pass Criteria

- Static checks pass.
- Fresh mode layout matches.
- Diff add/remove behavior matches.
- Guarded failure cases preserve the same safety semantics.
- Any intentional difference is documented in this file or in the
  relevant script comments.
