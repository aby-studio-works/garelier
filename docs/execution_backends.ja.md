# Execution & token efficiency

ロールのイテレーションがどのように **実行** されるか、そして固定のモデルのもとで
容量あたりにより多くの有用な作業をこなす方法について説明します。

> **プロバイダの利用規約と課金はオペレーターの責任です。** Garelier は
> いかなる構成についても「ToS-clean(利用規約に適合)」と認定せず、いずれの
> 実行モードについてもプロバイダがどのプラン・クレジット・API 予算で課金する
> かについて一切主張せず、課金関連の機能も同梱しません。`concepts.md` の
> **Billing & ToS** ノートを参照してください。

## The execution model: dispatch (DEC-057/061/066)

Garelier の実行基盤は1つだけです。ユーザーが付き添う **対話的な Dock**
セッション(artisan lane では PM、dock lane では Dock)が、各ロールの assignment
を **subagent** に委譲し — Agent ツール(1ロール)または Workflow ツール(並列)
で、リクエスト → 完了まで実行 → 返却 — その後、返された branch を
Guardian → Observer → merge gate を通して統合します。Codex/プールのロールも
`codex exec` サブプロセス経由で同じように動作します(DEC-058)。起こすべき
アイドルベイが存在しないため、wake 機構もデッドロックもありません。かつての
ヘッドレスな per-iteration ドライバ(`claude -p` / `codex exec`、「Mode B」)は
DEC-066 で完全に削除されました。その経緯はここではなく decision records に
残されています。

- **Producers** は studio の tip から切り出された分離された worktree で動作し
  (`scripts/dispatch_prepare.sh` が記帳作業 — id 確保、branch family、
  worktree、可視化イベント、context/pickup packs — を担当します)、実装し、quality gate を実行し、
  commit し、コンパクトな結果を返します。
- **The jig (Mode E, DEC-062 — default-on)** は tick を決定論的な Workflow
  スクリプトとして実行します: DISPATCH → GATE(Guardian→Observer、コードで
  順序を強制)→ INTEGRATE(`scripts/merge_request.sh` + LLM を使わない
  merge gate)→ RECORD(Status Web 向けのイベント)。`[jig] enabled = false`
  で散文 tick(`references/role_subagent_dispatch.md`)にオプトアウトできます。
- **Model routing**: 判断密度に応じて座席ごとにモデルを選びます
  (`references/model_routing.md`)— PM/Dock/Guardian/judge の座席には強いモデル
  を、gated producers には中位のモデルを割り当てます。

## Token efficiency (fixed model)

最適化の軸は、モデルを一定に保ったまま、容量あたりにより多くの有用な作業を
こなすことです:

- **Prompt cache.** 大きく安定したプレフィックス(role SKILL.md + CLAUDE.md +
  AGENTS.md + 固定ディレクティブ)をバイト単位で安定させ、かつ先頭に置くことで、
  サーバー側のキャッシュ読み出しが固定のイテレーションごとのオーバーヘッドを
  吸収できるようにします。
- **Context diet (DEC-049).** 本文をインライン化する代わりに、レポートや diff を
  パス + コンパクトな JSON サイドカーで参照します。コーディネーターは制限された
  サマリからトリアージします。Subagents は実際の作業のときだけ動作し、Dock は
  ターンとターンの間はおよそ 0 トークンでアイドルします。
- **Visibility.** Dispatch の進捗は Status Web(Work / Workflow tab、
  Dispatch activity パネル、Live work board)と `dock_status.ts` で可視化されます。producer の開始 /
  完了 / gate / merge イベントは、1つのコマンド — `scripts/dispatch_event.sh`
  — によって `runtime/dispatch/events.jsonl` に追記され、このコマンドは
  `backlog/in_flight.md` の派生ビューも再生成します(W-011, DEC-064 §3)。

## Not built (roadmap)

- 容量ガバナー(reset-time のパース / リセットまでの一時停止)— プロバイダの
  使用上限に達したら停止する、という方針が代わりに採用されています。
- 予算ガバナー — クレジット/API はオプションであり、設計の中心ではありません。
