# Status Web Console (read-only)

Garelier PM の現在状態をブラウザで見るための read-only console です。
Dashboard、Work queue、role status、reports、Librarian knowledge tree、
project file tree を表示します。runtime file を直接読んだり、AI に要約させたり
しなくても状況を確認できます。表示だけでは **AI token は消費しません**。

> この文書は console 内の **Guide** ページです。skill 側の
> `web_console.md` / `web_console.ja.md` と、人間向け copy の
> `docs/web_console.md` / `docs/web_console.ja.md` を同期してください。

## Starting and stopping it

`skills/garelier-core/driver/`(coordination tooling パッケージ)から起動する場合:

```bash
bun run status -- --pm-id <pm_id>
```

helper script を使う場合:

```bash
skills/garelier-core/scripts/start_status.sh --pm-id <pm_id> [--project /path]
skills/garelier-core/scripts/stop_status.sh  --pm-id <pm_id>
skills/garelier-core/scripts/status_web_status.sh --pm-id <pm_id>
```

PowerShell 版 (`start_status.ps1`, `stop_status.ps1`,
`status_web_status.ps1`) も同じ目的で使えます。host / port / refresh は
`__garelier/<pm_id>/_pm/setup_config.toml` の `[status_web]` で設定します。

port が使用中の場合は次の空き port を探します。複数 project / PM が同じ PC
で動いていても、それぞれ別 port で動けます。

**LAN viewing is the default.** 既定では `0.0.0.0` に bind し、同一 LAN 内の
別 PC から `http://<lan-ip>:<port>/` で見られます。browser UI では SNS 投稿用に
PM id、full project path、LAN URL / detail は既定で非表示になり、必要時だけ
Show button で表示します。local-only にしたい場合は
`[status_web] host = "127.0.0.1"` または `--loopback` を使います。LAN に公開
すると dashboard と browsable files は LAN 内の誰でも読めます。trusted LAN
向けの tool として扱ってください。

read-only かつ副作用なしで動きます。Garelier の状態を変更せず、provider CLI
も起動しません。

`control/control.toml` はあるが `_pm/setup_config.toml` はない
**control-only Garelier Control namespace** でも起動できます。この場合 Work /
Agents / Branches / Reports は自然に疎になりますが、Control / Knowledge /
dashboard / graph / Files は利用できます。Status Web が namespace を full
Garelier へ upgrade したり execution role を起動したりすることはありません。

## Theme

top bar に light/dark toggle と EN/JP description toggle があります。選択は
browser の localStorage に保存されます。heading、role name、state、chip は
runtime file や log と一致させるため英語のままです。説明文と helper text は
英語 / 日本語を切り替えます。初期言語は日本語です。

## What it shows

すべてを **7 つの view** に統合し、view 内のサブページはピル型タブで
切り替えます。旧 URL(`#/roles`, `#/reports`, `#/branches`, `#/routines`,
`#/sources`, `#/role-knowledge`, `#/troubleshooting`)は対応するタブへの
alias として引き続き機能します。

- **Dashboard** — LAN 監視向けの最初の画面です。health、rate-limit /
  blocker warning、LAN-vs-loopback、統合された live work board
  (active queue、held future queue、working、review/gate、done)、live agents、
  recent reports をまとめて表示します。
- **Work** — 詳細な作業面です。5 つのタブに分かれます:
  - **Live** — execution board、role rail、lane lock。進行は roadmap ->
    active/unblocked milestones -> backlog items -> phases として表示します。
    前提条件が許せば複数 milestone を同時に進められ、後続 milestone は見える
    状態のまま milestone/dependency gate が開くまで dispatch 保留になります。
  - **Workflow** — blueprint の PM-authored Pipeline packages を、package id、
    role、dependencies、status、assignment/report artifact、recent dispatch
    events として表示します。blueprints、STATE files、reports、
    `runtime/dispatch/events.jsonl` から派生し、dispatch は実行しません。
  - **Queue** — active/unblocked milestone queue、held future milestone
    queue、in-flight assignments、tier congestion、role capacity。queue table
    は 10 件ごとのページングで、blueprint から Markdown 全文を開けます。
  - **Agents** — configured role の stable slot id、provider、model、STATE、
    branch、稼働中の一時 producer、保留在庫、responsibility を表示します。
  - **Reports** — recent role reports です。行をクリックすると report 全文を
    Markdown render で開けます。
- **Knowledge** — ナレッジ面です。4 つのタブに分かれます:
  - **Curated** — Librarian が管理する tracked/curated knowledge tree
    (`<category>/` knowledge tree; DEC-029)と、local-only working area
    (`runtime/librarian/`; DEC-038)の summary。**knowledge graph** は
    ページ末尾にあり、category・document・role reading list・source・routine
    を接続し、dangling reference / format drift を報告します(本文は含まず
    metadata/pointer のみ)。
  - **ロール別** — `role_index.toml` knowledge index(DEC-048)を
    ロール別に表示します。各 role の `read_first` / `on_demand` と参照先本文、
    未配置 path を確認できます。
  - **Routines** / **Sources** — `routine_registry.toml` と
    `source_registry.toml` があれば表示します。登録済み routine/source が
    まだ無い状態は、古い install や Librarian が定型作業・外部 source を
    まだ登録していない project では normal です。
- **Control** — この PM の tracked `control/` authority の derived graph と
  canonical-contract validation です。graph は file から生成され、手で
  維持しません。
- **Files** — project file tree です。git-tracked/untracked files と、この PM の
  `__garelier/<pm_id>/` subtree を表示します。role worktree の `checkout/`、
  `.git/`、gitignored secret は表示対象から外します。`docs md` のような
  スペース区切り部分一致 AND で full path を絞り込めます。
- **Flow** — 2 つのタブ: **Pipeline** は command chain と work の流れの静的
  説明(lane、role、branch、merge gate、promote。`pipeline_flow.md` 参照)、
  **Branches** は `target`, `studio`, active branch と全 branch family
  (`satchel` / `workbench` / `anvil` / `shelf` / `spyglass` / `monocle` /
  `gavel` / `clipboard`)の owner / lifetime / namespace を表示します。
- **Guide** — この document と、**診断**(Diagnostics)タブ(warning と、
  console が止まって見える時の確認順序)です。

### Mermaid diagrams (optional, offline)

` ```mermaid ` block は local bundle が無い場合 source text のまま表示されます。
Garelier setup wizard は tool setup 時に Bun が利用でき、bundle が無い場合だけ
library を vendoring します。runtime で CDN は使いません。手動 fallback:

```bash
cd skills/garelier-core/driver && bun run vendor:mermaid
```

これは `static/vendor/mermaid.min.js` を local に保存します。minified bundle は
多数の third-party 依存をそれぞれの license のまま同梱するため、file は
**gitignored** で repo には commit しません（再配布しないので帰属義務も生じません）。
GitHub public / commercial use を想定して、runtime CDN と repo dependency の
追加を避けています。

## Warnings

- **stale_lane_lock** — `lane.lock` の owner pid が死んでいます。PM が確認して解除します。
- **failed_quality_gate** — 最新の merge-gate result が `failed` です。
- **dispatch_hold** — 明示的な hold が backlog を保留中です(意図的な停止)。
- **unresolved_review** — 例: role が REPORTING なのに `report.md` がありません。

## Security and cost

- LAN reachable が既定です。`--loopback` は `127.0.0.1` のみに制限します。
- read-only です。dispatch / abort / merge / lock-delete などの operation endpoint はありません。
- file viewer は browsable set の member だけを読めます。membership check、
  realpath containment、symlink skipping、secret filename exclusion で traversal
  と secret exposure を抑えます。
- Markdown は server-side で escape してから render します。repo document から
  `<script>` を注入できないようにしています。
- api key、token、password、private key は browser に届く前に redaction します。
- PM id、full project path、LAN URL / detail は UI 上で既定非表示です。
  必要な時だけ Show button で表示します。
- 表示だけでは Claude / Codex token を消費しません。

## Out of scope

operation UI、remote access beyond LAN、authentication、AI-generated summary は
意図的に対象外です。
