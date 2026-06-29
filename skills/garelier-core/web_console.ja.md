# Status Web Console (read-only)

Garelier PM の現在状態をブラウザで見るための read-only console です。
Dashboard、Work queue、role status、reports、Librarian knowledge tree、
project file tree を表示します。runtime file を直接読んだり、AI に要約させたり
しなくても状況を確認できます。表示だけでは **AI token は消費しません**。

## First time here

このコンソールが初めてなら、次の順で見てください。各ステップが次の理解に
つながります。

1. **Dashboard** — まずここ。PM が健全か、blocked / rate-limited が無いか、
   今何が動いているかが一目で分かります。
2. **Flow → Pipeline** — *各パーツの意味*。1 枚の図で command chain
   (User → PM → Dock/Artisan → producers → merge gate → studio → promote)、
   2 つの lane、全 role が分かります。一度読めば残りのコンソールが腑に落ち
   ます。**Flow → Branches** で各 branch family の名前を確認できます。
3. **Work** — *今起きていること*。**Live** は execution board、**Queue** は
   backlog 全体(active と held-future)、**Reports** は各 role が実際に行った
   こと。
4. **Knowledge / Control / Files** — *正本*。Knowledge は curated な読書セット、
   Control は計画の authority(roadmap / blueprints / decisions)、Files は
   その他すべてを閲覧できます。

コンソール全体を読み解く 2 つの鍵:

- **commit か report かで role が決まる。** Worker / Smith / Librarian /
  Artisan は commit を生み、PM / Scout / Observer / Guardian / Wanderer は
  生みません(Flow → Pipeline に一覧)。
- **held ≠ idle。** *future-milestone* の work しか queue に無い時、role は
  空いていても良いのです。その work は milestone/dependency gate により意図的に
  保留されているだけで、stuck ではありません。`FUTURE QUEUE` は正常な状態です。

すべて **read-only** です。dispatch / merge / state 編集は一切起きないので、
探索中は自由にクリックできます。

## Starting and stopping it

`skills/garelier-core/driver/` から起動する場合:

```bash
bun run status -- --pm-id <pm_id>
```

helper script を使う場合:

```bash
skills/garelier-core/scripts/start_status.sh --pm-id <pm_id> [--project /path]
skills/garelier-core/scripts/stop_status.sh --pm-id <pm_id>
skills/garelier-core/scripts/status_web_status.sh --pm-id <pm_id>
```

Windows でも Git Bash から同じ helper を実行します。host / port / refresh は
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
browser に保存されます。heading、role name、state、chip は
runtime file や log と一致させるため英語のままです。説明文と helper text は
英語 / 日本語を切り替えます。初期言語は日本語です。

## What it shows

すべてを **7 つの view** に統合し、view 内のサブページはピル型タブで切り替えます。

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
    events として表示します。派生 view であり、dispatch は実行しません。
  - **Queue** — active/unblocked milestone queue、held future milestone
    queue、in-flight assignments、tier congestion、role capacity。queue table
    は 10 件ごとのページングで、blueprint から Markdown 全文を開けます。
  - **Agents** — configured role の stable slot id、provider、model、STATE、
    branch、稼働中の一時 producer、保留在庫、responsibility を表示します。
  - **Reports** — recent role reports です。行をクリックすると report 全文を
    Markdown render で開けます。
- **Knowledge** — ナレッジ面です。5 つのタブに分かれます:
  - **Curated** — Librarian が管理する knowledge tree(engineering / quality /
    review / system / security / external operations)を、ソート可能な列テーブル
    (category / document / title / layer / path)で表示します。行クリックで
    document を開けます。committed な知識と local-only working area の summary を
    併記し、ページ末尾の **knowledge graph** が category・document・role reading
    list・source・routine を接続して dangling reference を示します。
  - **By role** — `role_index.toml` の逆引き索引を列テーブル(role / tier /
    document / title / layer / path)で表示します。各 role の `read_first` /
    `on_demand` を行クリックで開け、未配置 path も確認できます。
  - **Lens** — 共有 lens registry を列テーブル(pack / role / group / status /
    label)で表示し、各 pack の既定 group に印を付けます。行クリックで pack を
    開けます。Lens は role の判断フォーカスだけを変え、権限は変えません。未設定の
    場合は空です(Lens は opt-in)。
  - **Routines** / **Sources** — `routine_registry.toml` と
    `source_registry.toml` を列テーブルで表示します(空でもヘッダーは出ます)。
    **repo-file source** は行クリックで対象 document を、manual/target が解決
    できる routine はそのファイルを開きます。登録済み routine/source がまだ
    無い状態は、古い install や Librarian が定型作業・外部 source をまだ登録
    していない project では normal です。
- **Control** — この PM の tracked `control/` authority の derived graph と
  canonical-contract validation です。graph は file から生成され、手で
  維持しません。
- **Files** — project file tree です。ファイルをクリックすると**モーダル
  ビューワー**で開きます(tree は維持、inline の side pane は廃止)。
  git-tracked/untracked files と、この PM の
  `__garelier/<pm_id>/` subtree を表示します。role worktree の `checkout/`、
  `.git/`、gitignored secret は表示対象から外します。`docs md` のような
  スペース区切り部分一致 AND で full path を絞り込めます。
- **Flow** — 2 つのタブ: **Pipeline** は command chain と work の流れの静的
  説明(lane、role、branch、merge gate、promote。`pipeline_flow.md` 参照)、
  **Branches** は `target`, `studio`, active branch と全 branch family
  (`satchel` / `workbench` / `anvil` / `shelf` / `spyglass` / `monocle` /
  `gavel` / `clipboard`)の owner / lifetime / namespace を表示します。
- **Guide** — この document と、**Diagnostics** タブ(warning と、console が
  止まって見える時の確認順序)です。

## By situation — where to look

| やりたいこと | 見る場所 |
| --- | --- |
| 今おかしい所が無いか確認したい | **Dashboard** — health + warnings |
| 誰が何をするか、*satchel* / *gavel* などの用語を知りたい | **Flow → Pipeline**(role と chain)、**Flow → Branches**(branch family) |
| Worker / Smith が実際に何を変えたか知りたい | **Work → Reports**(行クリックで全文)→ 変更 path は **Files** |
| queue は埋まっているのに新規が始まらない理由 | **Work → Queue** — *held future* の item は milestone/dependency gate 待ちで、仕様どおり(stall ではない) |
| ある role が読むよう指示されている物を探す | **Knowledge → By role** — その `read_first` / `on_demand` |
| blueprint / decision / roadmap を読む | **Control**、または **Work → Queue**(各行が blueprint へリンク) |
| role が従う practice/policy を確認する | **Knowledge → Curated**、または **Knowledge → Sources**(repo-file source を行クリック) |
| merge 失敗に対応する | **Dashboard** `failed_quality_gate` → 詳細は **Work → Reports** |
| コンソールが止まって/idle に見える理由を調べる | **Guide → Diagnostics** — warning surface + 確認順(lane → merge gate → role STATE) |
| project / runtime の任意のファイルを開く | **Files** — path で絞り込み(例 `docs md`)してクリック |

### Mermaid diagrams (optional, offline)

` ```mermaid ` block は、local bundle があれば図として、無ければそのまま図の
ソースとして表示されます —— どちらでも Flow ページは読めます。setup wizard が
bundle を自動 vendoring します。手動で追加する場合:

```bash
cd skills/garelier-core/driver && bun run vendor:mermaid
```

bundle は local 配信され、repo には commit しません。

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
