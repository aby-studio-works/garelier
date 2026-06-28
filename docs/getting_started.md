# Getting Started / 導入手順

> v2.9.0 — the setup wizard described here is implemented in
> `skills/garelier-pm/scripts/setup_wizard.{sh,ps1}`.

> **Non-affiliation / 非提携.** Garelier is an independent community project.
> It works with Claude Code and Codex CLI but is not affiliated with, endorsed,
> or sponsored by Anthropic or OpenAI. "Claude", "Claude Code", and other marks
> belong to their respective owners.
> Garelier は独立したコミュニティプロジェクトです。Claude Code / Codex CLI と
> 連携しますが、Anthropic / OpenAI との公式な提携・承認・スポンサー関係は
> ありません。各製品名・サービス名はそれぞれの所有者の商標です。

本ドキュメントは、Garelier を新規プロジェクトに導入する手順を解説します。

## Table of Contents

1. [実行モード (Run modes)](#run-modes)
2. [前提環境](#prerequisites)
3. [スキルの一括配置 / プラグイン導入](#install-skills)
4. [プロジェクトの初期化](#initialize-project)
5. [初回起動と setup ウィザード](#first-run)
6. [エージェント編成の追加・削減 (Worker / Scout / Smith / Librarian / Observer / Artisan)](#scaling)
7. [ヘルスチェックと状態確認 (doctor / status / web console)](#health)
8. [Garelier を取り外す (Removing Garelier)](#removing)
9. [トラブルシューティング](#troubleshooting)

## <a id="run-modes"></a>1. 実行 (dispatch-only, DEC-061)

**PM は常に対話型です。** Garelier を PM との対話なしで使うことはありません。
PM が唯一の会話窓口で、`control/` を保持し、ゲートに回答し、promote を承認します。
PM 以外のパイプライン(Dock + producer + reviewer)は **dispatch** で動きます —
PM 対話セッションが各ロールをセッション内サブエージェント(Codex に割り当てた
role は `codex exec` subprocess)として実行します。

全マージは Guardian → Observer の固定順を通り、studio へ統合して PM 承認後に
promote します。goal を与えて自走させたい場合のみ、opt-in の Mode-D `/loop`
(既定 OFF)を arm します。

> **dispatch-only(DEC-061/066)。** headless `claude -p` ドライバは削除
> 済みです。provider 多様化(Codex)は dispatch producer として維持されます。
> 実行モデルは [execution_backends.md](execution_backends.md) を参照。

## <a id="prerequisites"></a>2. 前提環境

- Claude Code または Codex CLI がインストール済みであること
- git (with worktree support, ≥ 2.5)
- bash (Linux/macOS ネイティブ、Windows は MSYS2 / Git Bash)
- Windows で symbolic link を使う場合、開発者モード有効化または管理者権限
- 対象プロジェクトが git リポジトリで、最低 1 コミット存在すること
- Bun はヘルパースクリプト / merge gate / Status Web に必要です。未導入の場合、
  setup wizard が初回プロジェクト初期化時に確認して best-effort install /
  Mermaid vendoring を実行できます。
  Bun: `winget install Oven-sh.Bun` / `brew install oven-sh/bun/bun`
- PowerShell(`.ps1` ヘルパー用): Windows は同梱の 5.1+ で動作、PowerShell 7
  推奨(`winget install Microsoft.PowerShell`)。macOS / Linux は `.sh` 側を
  使うなら不要(使う場合は `brew install --cask powershell`)。
- Guardian role を有効化する場合、`[guardian_tools]` が指定する secret/PII
  scanner(既定は gitleaks)を PATH に通すこと。setup wizard は Guardian gates が
  設定され、gitleaks が未導入のときだけ確認します。producer はセッションの
  許可を継承するため、custom scanner は project-local allowlist が必要な
  場合があります。
  未インストールだと secret gate は PASS できず BLOCK / ENV-BLOCKED になる
  (`block_when_required_scanner_unavailable = true`)。
  gitleaks: `winget install Gitleaks.Gitleaks` / `brew install gitleaks`
  (詳細は `skills/garelier-librarian/templates/security/scanner_runbook.md`)
  gitleaks が使えない環境では、PM が
  `block_when_required_scanner_unavailable = false` と
  `[guardian_tools].secret_scan = "off"` を明示すると Guardian は縮退モードで
  継続できます。その場合、完全な secret scanner coverage は主張せず、
  `PASS_WITH_NOTES` / `NO_OPINION` として記録します。

## <a id="install-skills"></a>3. スキルの一括配置 / プラグイン導入

### Claude Code プラグインとして入れる(推奨)

公開された Garelier を使う一番簡単な方法は、Claude Code プラグインとして
入れることです。Claude Code 内で次を実行します。

```text
/plugin marketplace add aby-studio-works/garelier
/plugin install garelier@garelier
```

これで全 `garelier-*` skill が一度に使えるようになります。プラグインは
キャッシュ配置のため、手動の copy / symlink は不要です。fork から使う場合は
`<owner>/<repo>` を読み替えてください。導入後は
[プロジェクトの初期化](#initialize-project)へ進みます。

### スキルを手動で配置する(代替)

Claude Code は、skills ディレクトリに置かれた `garelier-*` ディレクトリを
参照します。role ごとに別々の操作をする必要はなく、まとめて copy すれば十分です。

```bash
git clone https://github.com/aby-studio-works/garelier.git
cd garelier
mkdir -p ~/.claude/skills
cp -R skills/garelier-* ~/.claude/skills/
```

PowerShell:

```powershell
git clone https://github.com/aby-studio-works/garelier.git
cd garelier
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force .\skills\garelier-* "$env:USERPROFILE\.claude\skills\"
```

(fork から使う場合は clone URL を読み替えてください。)

開発中に clone 先の変更をそのまま使いたい場合は、copy ではなく symbolic link
を使えます。clone した repo で Claude Code を起動し、
「この repo の `skills/garelier-*` を Claude Code の skills ディレクトリへ
copy または symlink で配置して」と依頼しても構いません。

`garelier-pm`, `garelier-worker`, `garelier-guardian` などに分かれているのは、
Claude Code が必要な role skill だけを起動し、毎回読む文脈を小さく保つためです。
共有契約は `garelier-core` に集約し、各 role skill は薄い入口として使います。

`install.sh` / `install.ps1` は、上記の一括配置を自動化する任意ヘルパーです。
内容を確認したうえで使う場合は次のように実行できます。

```bash
./install.sh
```

```powershell
.\install.ps1
```

ZIP で取得した場合、`.sh` の実行属性が落ちている可能性があります。その場合は
`bash install.sh` で起動するか、必要な helper script に実行属性を戻してください。
Bun / gitleaks / Mermaid bundle などの不足分は、対象プロジェクトで
`garelier-pm` setup wizard を起動した時に確認されます。

### スキル開発(dev mode)

公開時のランタイムは **plugin** です(Claude Code が `${CLAUDE_PLUGIN_ROOT}` を
設定し、docs 内のパスはこれを基準に解決されます)。ローカルの checkout に対して
skill を開発する場合は、上記の symlink 配置を残したうえで `CLAUDE_PLUGIN_ROOT`
を自分の garelier checkout に向けて export します。これで docs 内の
`${CLAUDE_PLUGIN_ROOT}` パスが dev でも同じように解決されます。

checkout のルートで実行する場合(別の場所ならそのパスに読み替え):

```bash
export CLAUDE_PLUGIN_ROOT="$(pwd)"
```

```powershell
$env:CLAUDE_PLUGIN_ROOT = (Get-Location).Path
```

## <a id="initialize-project"></a>4. プロジェクトの初期化

対象プロジェクトの git repo ルートで Claude Code を起動し、`garelier-pm`
skill でセットアップします。

```bash
cd /path/to/your-project
claude
```

Claude Code で「`garelier-pm` を使ってこのプロジェクトをセットアップして」
と依頼すると、PM skill が setup wizard を案内します。手作業で
`__garelier/<pm_id>/_pm/CLAUDE.md` を作る必要はありません。

## <a id="first-run"></a>5. 初回起動と setup ウィザード

PM skill は `__garelier/<pm_id>/runtime/` の存在を確認します。未初期化なら
setup wizard が対話的に以下を質問します。

1. プロジェクト名
2. `pm_id`
3. **Target branch**(規定: `main`、または `staging` / `main/soft` など)
   - スラッシュを含む場合は `-` で連結したスラグを生成
   - 例: `develop/soft` → slug `develop-soft`
4. role 構成(Worker / Scout / Smith / Librarian / Observer / Guardian /
   Concierge / Artisan)
5. quality gate
6. permission profile
7. AGENTS.md 方針
8. 初期マイルストーン

非対話で実行する場合の主な引数(bash は `--`、PowerShell は `-`):

- `--stack rust|typescript|python|go|mixed|custom` — quality gate の既定
  コマンドセットと AGENTS.md の言語欄を決定(規定 `rust`。custom/mixed は
  `--quality-gate` 必須)
- `--quality-gate "<cmd>"`(繰り返し可) — stack 既定を上書きする明示コマンド
- `--permission-profile safe|reviewed|dangerous` — provider 自律度
  (規定 `reviewed`。`dangerous` はフルアクセスで opt-in 専用)
- `--librarians "<id:provider[:model],...>"` — Librarian 編成(DEC-018)
- `--observers "<id:provider[:model],...>"` — Observer 編成(DEC-019)
- `--guardians "<id:provider[:model],...>"` — Guardian 編成(DEC-024)
- `--concierges "<id:provider[:model],...>"` — Concierge 編成(DEC-025)
- `--artisan` — artisan lane を有効化(DEC-017、単一エージェントで一括実行)

回答後、ウィザードが以下を実行します。

- `garelier/<target-slug>/<pm_id>/studio` ブランチの作成 (未存在の場合)
- `__garelier/<pm_id>/control/` のディレクトリ構造作成
  (project_dashboard / operations / blueprints / inspections / observations /
  delegation / request_intake / scheduled_jobs / decisions / reports)
- `__garelier/<pm_id>/runtime/` のディレクトリ構造作成
  (manifest / backlog / dock / pm / requests / observer / guardian /
  concierge / librarian / scheduled_jobs / merge_gate / driver)
- role コンテナの事前作成は **しません**(DEC-065 dispatch-native)。
  `_dock/` / `_workers/<id>/` / `_artisan/` 等は作られず、producer は一時的な
  `_dispatch<N>/` ホームで実行されます。`setup_config.toml` の role 編成は
  シート既定値(provider/model ルーティング)です。永続コンテナが必要に
  なったときだけ diff mode で明示的に追加します
- `__garelier/<pm_id>/runtime/manifest.md`, `__garelier/<pm_id>/_pm/history.md` を初期化
- `__garelier/<pm_id>/_pm/setup_config.toml` を保存
  (branch、quality gate、permission、role 編成、gate policy を記録)
- `AGENTS.md` をテンプレートから生成(言語・build/test・quality gate は
  `--stack` と quality gate から自動補完。restricted files §3 と conventions §10
  だけ `{{placeholder}}` が残る)
- `__garelier/<pm_id>/control/operations/promote_checklist.md` 等の安全ルールを
  シードとして配置

> **重要(初回の必須ステップ — ただし宿題ではありません):** fresh setup 直後の
> `AGENTS.md` には、プロジェクト固有の restricted files / conventions が
> `{{...}}` のまま残り、`doctor` が **P0 placeholder-leak** として検出します
> (P0 が残ったまま dispatch ループを arm しない — 安全側の仕様)。
> **PM がリポジトリのスキャン結果から下書きを提案する**ので、ユーザーは
> エディタを開かず**承認するだけ**で埋まります(DEC-068。`setup_wizard` の
> 再実行では既存 `AGENTS.md` は上書きされません)。もちろん後から自由に
> 手で編集できます — `AGENTS.md` はユーザー所有です。

### dispatch を快適にする権限設定(推奨)

producer サブエージェントは **PM セッションの権限を継承**します。許可リストが
未整備だと、初回 dispatch で `cargo test` や `git` のたびに確認プロンプトが
出ます。快適に流すには、プロジェクトの quality gate コマンド群と git の基本
操作をセッションの許可リストに入れてください(例:`.claude/settings.json`):

```json
{
  "permissions": {
    "allow": [
      "Bash(cargo build:*)", "Bash(cargo test:*)",
      "Bash(cargo clippy:*)", "Bash(cargo fmt:*)",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git worktree:*)"
    ]
  }
}
```

コマンドは自分のプロジェクトの gate(AGENTS.md §2)に読み替えてください。
`dangerous` プロファイルは不要です — 許可リストはユーザーが内容を見て選んだ
コマンドだけを通し、それ以外は通常どおり確認が出ます。

(完全な対話例は garelier-pm の SKILL.md および scripts/setup_wizard.{sh,ps1} の
コメントを参照)

## <a id="scaling"></a>6. エージェント編成の追加・削減 (Worker / Scout / Smith / Librarian / Observer / Artisan)

`__garelier/<pm_id>/_pm/setup_config.toml` を編集する代わりに、PM に依頼すると
ウィザードが差分モードで起動します。

```bash
cd /path/to/your-project
claude  # PM に "Worker を1体追加して" と伝える
```

PM は `setup_config.toml` の変更を検出し、追加分の worktree のみを生成、
既存のものには触りません。diff mode の追加は永続 role コンテナを作る
**唯一の**経路です(DEC-065 — fresh setup は何も事前作成しません)。
**追加前に `<target>` を
`garelier/<target-slug>/<pm_id>/studio` にマージ**して、新規 worktree が最新の
統合ブランチから切られるようにします。conflict が出た場合は PM が
自力解消(DEC-001 §2.5)。削減時は対象が `IDLE` 状態であることを確認
した上で `git worktree remove` を実行します。Smith は `--smiths`
(PowerShell は `-Smiths`) で diff mode に追加・削減できます。省略時は既存
Smith 編成を保持し、明示的な空指定なら削除候補になります。

Smith 数は Worker 数との比率を見てユーザが調整します。現在の残対象は
`status.{sh,ps1}` の Backlog 欄に出る
`Smith hardening targets remaining` を見ます。

Librarian / Observer も同じ diff mode セマンティクスで増減できます
(`--librarians` / `--observers`、PowerShell は `-Librarians` / `-Observers`。
省略=既存維持、空文字 `""`=全削除)。artisan lane は `--artisan` /
`--no-artisan`(`-Artisan` / `-NoArtisan`)でトグルし、`_artisan` worktree を
`<target>` から作成・削除します。Observer 初回追加時は
`runtime/observer/` と `control/observations/` を自動でスキャフォールドします。

```bash
garelier status --pm-id <pm_id> --project /path/to/your-project
```

## <a id="health"></a>7. ヘルスチェックと状態確認 (doctor / status / web console)

- **doctor**(read-only 健康診断): 1 PM のインストールを点検し、
  P0(起動阻害)/ P1(警告)/ P2(助言)で報告します。placeholder 漏れ、
  quality gate 未定義・stack 不一致、`dangerous` 権限、stale な
  `lane.lock`、version drift 等を検出します。

  ```bash
  garelier doctor --pm-id <pm_id> --project /path/to/your-project
  ```

- **status**(CLI 一覧): lane / merge gate(直近結果と pending)/ backlog /
  LIVE な `_dispatch<N>` producer / 退避在庫(parked inventory)/ 最近の
  dispatch イベントを表示します。`--watch <秒>` で定期更新。

- **status web console**(ローカル read-only ブラウザビュー): Dashboard /
  Work / Knowledge / Control / Files / Flow / Guide の 7 ビューで lane /
  merge gate / dispatch アクティビティ / 最近のレポート等を表示します。AI
  トークンを消費せず、状態を変更しません。

  ```bash
  cd skills/garelier-core/driver && bun run status -- --pm-id <pm_id>
  #=> http://127.0.0.1:3787/
  ```

- **session digest**(対話 PM 起動時の自動サマリ): `__garelier/<pm_id>/_pm/`
  を直接開く運用では、SessionStart フックが lane / merge gate / LIVE dispatch
  数 / inbox 件数 / merge-gate・observer results / doctor サマリを数行で
  提示します。**AI を呼ばない決定論的出力**なので
  「状況を要約して」と尋ねる 1 ターン分のトークンを節約できます
  (`scripts/session_digest.{sh,ps1}`、fresh setup で settings.json に自動配線)。

## <a id="removing"></a>8. Garelier を取り外す (Removing Garelier)

Garelier は対象プロジェクトに対して非介入・除去可能なレイヤーです(DEC-051)。
取り外しても、対象プロジェクトは通常の git / build / test でそのまま使えます。
クリーンアンインストールは次の手順です。

1. **実行を停止する。** dispatch の `/loop` を arm 済みなら止めます(PM に「止めて」
   と依頼)。
2. **進行中の dispatch を終わらせる。** LIVE な `_dispatch<N>/` producer が
   あれば完了を待ち、`dispatch_cleanup.{sh,ps1}` で片付けます。退避在庫
   (parked inventory)があれば PM の clean stop 手順で処置します。`status`
   で確認できます。
3. **worktree を外す。** `__garelier/<pm_id>/_dispatch<N>/checkout` と、
   diff mode で追加していた場合は `__garelier/<pm_id>/_*/<id>/checkout` を
   `git worktree remove <path>` で削除します(`git worktree list` で確認)。
4. **ローカルの `garelier/*` ブランチを削除する。**
   `studio` / `workbench` / `anvil` / `satchel` / `shelf` などはローカル限定で
   push されません。`git branch --list 'garelier/*'` で一覧し、`git branch -D` で
   削除します。
5. **`__garelier/` を削除する。** `rm -rf __garelier/`(PowerShell は
   `Remove-Item -Recurse -Force __garelier`)。nested ignore
   (`__garelier/.gitignore` / `__garelier/.ignore`)も一緒に消えます。

リポジトリルートへの書き込みは、利用者が所有する `AGENTS.md` だけです。Garelier は
リポジトリルートの `.gitignore` も、共有 CI gate も、git hook も追加しません
(DEC-051)。`AGENTS.md` を残すか消すかは利用者の判断です。

## <a id="troubleshooting"></a>9. トラブルシューティング

- **fresh setup 直後に `doctor` が P0 を出す (placeholder-leak)**
  `AGENTS.md` のプロジェクト固有フィールド(restricted files §3、conventions §10)が
  `{{...}}` のまま残っています。これは仕様です — エージェントが従うべき
  プロジェクト規約が未定義のまま dispatch ループを arm しないようにブロック
  しています。`AGENTS.md` を編集して `{{...}}` を埋めてください。言語・
  build/test・quality gate は `--stack` から自動補完済みです。`setup_wizard` の
  再実行は既存 `AGENTS.md` をスキップするため placeholder は埋まりません。

- **インストール後に PM が Garelier スキルを見つけない**
  `~/.claude/skills/` (Windows は `%USERPROFILE%\.claude\skills\`) に
  `garelier-core`, `garelier-pm`, `garelier-dock`,
  `garelier-worker`, `garelier-scout`, `garelier-smith`,
  `garelier-artisan`, `garelier-librarian`, `garelier-observer`,
  `garelier-guardian`, `garelier-concierge` があるか確認します。無ければ
  framework repo の `skills/garelier-*` を copy し直すか、任意ヘルパーの
  `install.sh` / `install.ps1` を実行します。ZIP 取得で実行属性が落ちている場合は
  `bash install.sh` を使います。

- **`install.ps1` が symlink 作成で失敗する**
  任意ヘルパーで symbolic link を作る場合、Windows Developer Mode が無効、
  または権限不足だと失敗します。Developer Mode を有効化して PowerShell を
  開き直すか、管理者 PowerShell で実行します。copy 配置ならこの条件は不要です。

- **`Error: this script must run from the project's __garelier/<pm_id>/_pm/ directory.`**
  低レベルの setup wizard script を直接 `diff` mode で実行した時のエラーです。
  通常は target project のルートで Claude Code を起動し、PM に変更を依頼します。
  script を直接実行する場合だけ、`__garelier/<pm_id>/_pm/` に移動します。

- **`Repository has no commits. Make at least one commit first.`**
  target project が空の git repo です。`git status` で状態を確認し、
  README や `.gitignore` など最初の commit を作ってから fresh setup を
  やり直します。Garelier は worktree と branch を作るため、初期 commit が
  必要です。

- **`Target branch '<name>' does not exist.`**
  setup で指定した target が存在しません。`git branch --list` で確認し、
  既存 branch 名を指定するか、先に target branch を作成してください。
  detached HEAD 上で target を自動判定できない場合は `--target <branch>`
  (PowerShell は `-Target <branch>`) を明示します。

- **PM が setup ウィザードを起動しない**
  既に `__garelier/<pm_id>/runtime/` が存在すると初期化済みと判断します。agent 数の
  変更は diff mode を使います。完全にやり直したい場合だけ、作業内容を確認
  した上で `__garelier/` を退避または削除してから再起動します。

- **diff mode で `state is not IDLE` / exit code 2 になる**
  削除対象の Worker / Scout / Smith が作業中です。`__garelier/<pm_id>/_workers/<id>/STATE.md`,
  `__garelier/<pm_id>/_scouts/<id>/STATE.md`, または
  `__garelier/<pm_id>/_smiths/<id>/STATE.md` を確認します。完了を待つか、
  PM の clean stop 手順で `abort.md` を発行してから diff mode を再実行します。
  worktree を手で消すと manifest や setup_config とずれます。

- **setup wizard が exit code 3 で停止する**
  diff mode で新しい worktree を追加する前の target 追従マージに conflict が
  出ています。PM が `studio` 上で conflict を解消し(DEC-001 §2.5)、
  `git status` が clean になってから同じ diff mode を再実行します。

- **`Failed to create worktree at __garelier/<pm_id>/_workers/<id>`**
  同名ディレクトリ、古い worktree 登録、または branch 参照が残っている可能性が
  あります。`git worktree list` で登録状態を確認し、不要な stale worktree を
  整理してから再実行します。作業中 agent の worktree は削除しないでください。

- **Worker / Scout / Smith が `BLOCKED` から戻らない**
  Worker は `__garelier/<pm_id>/_workers/<id>/questions.md`、Scout は
  `__garelier/<pm_id>/_scouts/<id>/questions.md`、Smith は
  `__garelier/<pm_id>/_smiths/<id>/questions.md` を確認します。Dock が回答できる
  ものは `answers.md` で返し、ユーザ判断が必要なものは PM escalation に進めます。

- **「branch 'garelier/develop/soft/studio' is invalid」と git に言われる**
  target 名がスラッシュを含むのに slug 変換が漏れています。target =
  `develop/soft` なら slug = `develop-soft`、studio branch =
  `garelier/develop-soft/studio` を使います。
