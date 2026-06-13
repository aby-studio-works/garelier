# Garelier

> **v2.6.4**

Garelier は、Claude Code / Codex CLI を、役割分担・ファイルハンドオフ・
ナレッジに沿ったゲート管理で統制し、AI のロール管理で長期プロジェクトの
開発状態を整理して継続的に進めやすくする、人間監督下のマルチエージェント
開発フレームワークです。

![Status Web ダッシュボード](assets/readme/status_web_dashboard01.png)

![Status Web 作業画面](assets/readme/status_web_work01.png)

## 提供形態

- **Garelier Control**(role / lane / worktree なしの最小管理面):
  `garelier-control-project`(計画・backlog・判断・graph・読み取り専用
  Status Web)、`garelier-control-library`(ナレッジの検索・保存・標準化)、
  またはその併用。後から同じデータのまま Full Garelier へ移行できます。
- **Garelier Plugin Artisan**: Control + PM 案内の Artisan lane 単独実行。
- **Garelier Plugin Full Garelier**: Control + 全 role、dock / artisan 両 lane、
  runtime、branch。

`Plugin` は複数 skill / lane をまとめた利用者向けの呼称で、skill folder 名や
技術的な package 名には使いません。

## 特徴

- **役割分担**: PM が意図と計画、Dock が分解・統合、Worker / Scout / Smith /
  Librarian / Artisan が実装・調査・統合硬化・知識管理・単独完遂、Observer /
  Guardian / Concierge がレビュー・ゲート・外部操作を分離します。
- **2 つの実行レーン**: `dock lane`(PM → Dock → 複数ロール → studio → promote)
  と `artisan lane`(PM → Artisan → Guardian → Observer → studio → promote)。
  `runtime/lane.lock` で排他。どちらも studio へ統合し、PM 承認後に Concierge が
  target へ promote します。
- **ファイルベースのハンドオフ**: `control/` は永続的な計画・判断・成果物、
  `runtime/` は一時状態。依頼・報告・質問・レビュー結果は Markdown / TOML / JSON
  で残ります。
- **ナレッジに沿ったゲート**: Guardian が秘密情報 / PII / 依存 / ライセンス / 出所
  を Librarian 管理のナレッジに沿って確認。Concierge が promote / push 等の承認済み
  外部操作を担当。外部知識は原文コピーせず、出所を残してプロジェクト固有の言葉に
  一般化します。
- **Status Web**: lane / role / merge gate / queue / reports / knowledge / files
  を読み取り専用で確認。PM id / path / LAN URL は既定で隠します。
- **使用量を抑える設計**: role skill は薄い入口にし、詳細は必要時だけ references を
  読みます。compact handoff と output control で runtime 文書と provider 出力を
  膨らませません。

## 実行(dispatch)

**PM は常に対話型**で、唯一の会話窓口として `control/` を保持し、ゲートに回答し、
promote を承認します。PM 以外のパイプライン(Dock + producer + reviewer)は
**dispatch** で動きます — 各ロールを PM 対話セッション内のサブエージェント
(Codex に割り当てたロールは `codex exec` subprocess)として実行します。全マージは Guardian → Observer の固定順を通り、studio へ統合して PM 承認後に
promote します。

> **自律ループは opt-in**: goal を与えて自走する自律ループ(self-paced
> `/loop`)は既定 OFF(`[autonomy] enabled = false`)です。tick(OBSERVE → DISPATCH →
> Guardian → Observer → merge gate → RECORD + 4 つの人間判断ゲート)は
> **jig**(DEC-062、既定 ON)が決定的なコードとして実行し、producer の worktree
> 準備・merge request 生成・可視化イベントはヘルパーが自動化します
> ([`mode_e_jig.md`](skills/garelier-core/references/mode_e_jig.md))。
> 旧 headless driver(Mode B)は削除済みです(DEC-066)。

## 導入

必要なもの(git 2.5 以上は導入済み前提):

- Bun 1.3.14 以上(スクリプト・merge gate・Status Web の実行系)
- 実行 CLI: Claude Code、Codex CLI
- gitleaks(Guardian の秘密情報確認用。無い場合は該当 gate が BLOCK、
  `secret_scan = "off"` で縮退可)
- PowerShell(`.ps1` ヘルパー用。Windows は同梱の 5.1+ で動作、PowerShell 7
  推奨。macOS / Linux は `.sh` 側を使うなら不要)
- Windows で symlink を使う場合は Developer Mode または管理者権限

インストール例:

```bash
# Windows (winget)
winget install Oven-sh.Bun
winget install Gitleaks.Gitleaks
winget install Microsoft.PowerShell   # PowerShell 7(推奨)

# macOS (Homebrew)
brew install oven-sh/bun/bun
brew install gitleaks
brew install --cask powershell        # .ps1 ヘルパーを使う場合のみ
```

### Claude Code プラグインとして入れる(推奨)

```text
/plugin marketplace add aby-studio-works/garelier
/plugin install garelier@garelier
```

これで全 `garelier-*` skill が使えます(キャッシュ配置のため手動 copy /
symlink 不要)。fork から使う場合は `<owner>/<repo>` を読み替えてください。
手動配置・dev mode は [docs/getting_started.md](docs/getting_started.md) を参照。

## 使い始める流れ

利用先プロジェクトの git repo ルートで Claude Code を開き、`garelier-pm` skill を
使った Claude と会話するだけです。内部コマンドを覚える必要はありません。

1. **セットアップ**:「`garelier-pm` でこのプロジェクトをセットアップして」。
   PM が先にリポジトリをスキャンして stack・build/test コマンド・target branch
   を検出し、サマリ 1 枚の確認で初期化します(実質の質問は `pm_id` のみ。
   単一ユーザ既定 `_workshop`)。
2. **AGENTS.md の確定(承認だけ)**: fresh setup 直後は restricted files /
   conventions が `{{...}}` で残り `doctor` が **P0** を出しますが、**PM が
   スキャン結果から下書きを提案する**ので承認するだけで埋まります(DEC-068)。
   jig tick は実行前に doctor を自動で前検査し、P0 が残っていれば何も
   dispatch せずに tick を保留します。
3. **設計図**:「`<やりたいこと>` の設計図を作って」。PM が目的・範囲・受け入れ
   条件・確認方法・リスク・role 分担を整理し `control/blueprints/` に保存します。
4. **実行**:「その設計図で進めて」。doctor 確認後、Dock が dispatch でロールを
   実行し、各マージを Guardian → Observer で studio へ統合します。goal まで
   自走させたい場合は `/loop` を arm します。
5. **Status Web**:「Status Web を起動して」。読み取り専用の URL を案内します。

ナレッジ追加は「`<コーディング規約や外部ドキュメント>` を扱えるように」と依頼すれば
PM が Librarian に回します(個人開発でも同じ — 自分の規約・使用ライブラリの仕様・
プロジェクト固有のルール等、エージェントに参照させたい情報なら何でも)。詳細な
初期化手順は [docs/getting_started.md](docs/getting_started.md)。

## Garelier を取り外す

Garelier は対象プロジェクトに非介入・除去可能なレイヤーです(DEC-051)。取り外しても
通常の git / build / test でそのまま使えます。

1. 実行を停止する(`/loop` を止める。PM に「止めて」と依頼)。
2. 全 role を `IDLE` にする(作業中なら完了を待つ)。
3. 稼働中の producer worktree があれば外す: `git worktree remove <path>`
   (`__garelier/<pm_id>/_dispatch<N>/checkout`。通常はタスク完了時に自動で
   片付くため、残っているのは中断時のみ)。
4. ローカルの `garelier/*` ブランチを一括削除する(push されません)。
5. `__garelier/` を削除する(`rm -rf __garelier/`。nested ignore も消えます)。

リポジトリルートへの書き込みは利用者所有の `AGENTS.md` だけです。`.gitignore`・
共有 CI gate・git hook は追加しません。

## 主なドキュメント

- [AGENTS.md](AGENTS.md): 用語、role 境界、ハードルール
- [docs/getting_started.md](docs/getting_started.md): 導入手順
- [docs/concepts.md](docs/concepts.md): 全体概念
- [docs/protocol.md](docs/protocol.md): ファイルプロトコル
- [docs/state_machine.md](docs/state_machine.md): 状態遷移
- [docs/web_console.md](docs/web_console.md): Status Web
- [docs/canonical_index.md](docs/canonical_index.md): 正本の所在
- [CHANGELOG.md](CHANGELOG.md): 実装履歴

## ライセンス

Apache License 2.0。詳細は [LICENSE](LICENSE) を参照してください。

## 非提携

Garelier は、OpenAI、Anthropic、Claude Code、Codex CLI とは、公式な提携・承認・
スポンサー関係にありません。Claude Code、Codex CLI、その他の製品名・サービス名は、
それぞれの所有者の商標またはサービス名です。

## 免責

Garelier は現状有姿で提供されます。プロジェクトへの適用、外部操作、生成物の確認、
AI 実行 CLI の利用判断は利用者の責任です。保証および責任制限の詳細は
[LICENSE](LICENSE) の Apache License 2.0 に従います。
