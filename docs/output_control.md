# Output Control

> ランタイム契約 `skills/garelier-core/output_control.md` と DEC-028 の
> 根拠説明に対応する、人間向けの解説です。この三者は常に同期させて
> ください。

Garelier はロール一式をフルに動かしますが、それは意図的なものです。この重さは
統制された AI 労働の対価です。しかし長期運用のなかで、統制とは無関係に
青天井で膨らんでいたものが二つありました。

1. プロバイダの **final response** ——耐久性のある詳細はすでに
   `report.md` / inspections / `STATE.md` に書き込まれているのに長文化し、
   毎イテレーションで driver のロール別会話ログを肥大化させていました。
2. driver の **JSONL log files**、および固定 1000 文字の `model_result`
   切り詰め——ロール別チューニングも超過シグナルもありませんでした。

Output Control(`[output_control]`、DEC-028)は、まさにこれらに対処します。
既存の compact-handoff(耐久的なロール間ファイル)と retention(履歴の
エイジング/アーカイブ)の **上に重ねる** もので、どちらも置き換えません。

## What it does

- **Per-role output profiles.** `normal` / `compact` / `micro` の各プロファイルは
  `soft_result_chars` 予算を持ちます。driver はイテレーションプロンプトに
  短いディレクティブを付加し、プロバイダに FINAL response をその予算内に
  収め、耐久的な詳細は公式ファイルへ書くよう求めます。
- **Excerpt logging.** `model_result` は上限付きの抜粋
  (`model_result_log_chars`)として、`result_chars` / `output_profile` /
  `over_budget` とともに保存されます。完全なレスポンスは引き続きロール状態の
  判定に使われ、保存される抜粋だけが上限の対象です。
- **Over-budget warning.** 長すぎるレスポンスは `output_budget_exceeded` を
  記録します。これは観測であって失敗ではありません(`violation_mode = "warn"`;
  `"fail"` は実験的)。
- **Usage summary.** OK となった各イテレーションにつき 1 レコードを
  `runtime/driver/usage/YYYY-MM.jsonl` に記録します——role、provider、profile、
  tokens、cost、result_chars、over_budget——どのロールが時間とともに出力を
  肥大化させているかを把握できます。
- **Log rotation.** driver とロール別の JSONL logs は
  `driver_log_max_bytes` でローテーションし、`driver_log_keep_files` 個の
  ローテーション済みファイルを保持します。

## What it never does

- code、file paths、commands、URLs、error text、日付、数値、commit SHAs を
  省略することは決してありません。
- リスク、ブロッカー、警告、必要な承認、責任境界を隠すことは決して
  ありません。**Guardian と Concierge は既定で `normal`** であり、まさに
  安全に関わる内容が短縮を強いられないようにするためです。
- ロール状態のパースに使われる結果を切り詰めることは決してありません。
- public/user-facing なドキュメントやソースコードを圧縮することは決してなく、
  外部の圧縮ツールやコピーした外部表現にも依存しません。

## Configuration

```toml
[output_control]
enabled = true
default_profile = "compact"          # normal | compact | micro
violation_mode = "warn"              # warn (observe) | fail (experimental)
model_result_log_chars = 600         # excerpt cap in driver JSONL (100–5000)
error_tail_chars = 500               # stderr/stdout tail kept on failure
driver_log_max_bytes = 10485760      # rotate JSONL past this size
driver_log_keep_files = 10
usage_summary = true                 # runtime/driver/usage/YYYY-MM.jsonl

[output_control.profiles.normal]  ; soft_result_chars = 1600, max_bullets = 8
[output_control.profiles.compact] ; soft_result_chars = 900,  max_bullets = 5
[output_control.profiles.micro]   ; soft_result_chars = 500,  max_bullets = 3

[output_control.roles]
pm = "normal"        # decisions / blueprint rationale
guardian = "normal"  # never pressure safety warnings short
concierge = "normal" # never pressure external-op conditions short
scout = "micro"      # detail lives in the inspection
observer = "micro"   # detail lives in the observation
# … worker/smith/artisan/librarian/dock = compact
```

`[output_control]` が無い場合 ⇒ これらの既定値が適用されます(有効)。
三つの名前以外の `default_profile`、不正な `violation_mode`、200 未満の
`soft_result_chars` はハードな設定エラーです。`model_result_log_chars` は
[100, 5000] にクランプされます。

## Visibility

- **doctor** は、不正な profile / violation_mode、1 MB 未満のローテーション
  サイズ、200 未満の予算を P0 として、`guardian`/`concierge = "micro"` または
  `violation_mode = "fail"` を P1 として、`enabled = false` /
  `usage_summary = false` を P2 として指摘します。
- **status** は、output control が有効かどうかと、直近月の超過比率を表示します
  (読み取り専用; プロバイダトークン消費はゼロ)。

## Relationship to other layers

| Layer          | Governs                                   |
| -------------- | ----------------------------------------- |
| Compact handoff (DEC-005) | 耐久的なロール間ファイル(ポインタのみ、本文の貼り付けなし) |
| Retention (DEC-009)       | 履歴のエイジング/アーカイブ              |
| **Output Control (DEC-028)** | プロバイダの final response + driver ログの保存 |
