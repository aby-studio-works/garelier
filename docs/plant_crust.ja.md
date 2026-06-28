# Plant-Crust 外部管理レイアウト

Plant-Crust は、Garelier の管理面を target repository の外に置くための
外部管理レイアウトです。

## レイアウト

```text
<workfolder>/
├── crust.toml
└── <container>/
    ├── container.lock.toml
    ├── __garelier/
    └── target/
        └── .git/
```

従来の project 内配置は Plant-Lithosphere として残ります:
`control_root == target_root`。Plant-Crust では workfolder は container registry
だけです。選択 container が control root、その `target/` が target Git
repository です: `control_root != target_root`。`workfolder/__garelier` は
作らず、PM control root としても扱いません。

## ルール

- `target/__garelier` は禁止です。
- `workfolder/__garelier` は未使用です。workfolder 直下に中央 control plane
  を作らないでください。
- v1 では 1 container に target checkout は 1 つだけです。
- `crust.toml` は workfolder の最小台帳です。各 container は `id`、必要な
  場合だけ `path` を持ちます。target path / target branch / target remote /
  policy は `container.lock.toml` が固定します。
- dispatch と merge-gate の runtime は container 側
  `__garelier/<pm_id>/runtime/` に残ります。
- Git worktree、branch、merge、quality gate は `target/` で実行します。
- PM は登録済み container の `__garelier/<pm_id>/` を横断して読み、選択した
  container の Dock request を書けます。Dock / Worker / Scout / Smith /
  Librarian / Guardian / Observer / Artisan / Concierge は active container
  専属です。

## Git ownership

`workfolder.git` と `target.git` は役割が違います。

- `workfolder.git`: `crust.toml`、container 側の `container.lock.toml`、
  container 側 `__garelier/` の control/runtime state を管理します。
- `target.git`: 対象プロジェクト branch と、`garelier/<target-slug>/<pm_id>/studio`、
  `workbench/...`、`anvil/...`、`shelf/...`、`satchel/...`、ephemeral gate
  branch を含む Garelier 実行 branch を持ちます。

`garelier/*` branch hierarchy を `workfolder.git` 側に作らないでください。

## ツール

- `garelier crust-init --workfolder <path> --container-id <id>` で Crust
  descriptors を作成し、`target/` に対して通常 setup を実行できます。既存の
  `crust.toml` がある場合は workfolder 台帳へ container を追加し、既存の
  `[[containers]]` は保持します。同じ container id は失敗します。
- `garelier plant-resolve --start <path>` で Plant mode と root を確認できます。
  workfolder root では registry scope を返し、`workfolder/__garelier` は
  control root として返しません。
- `garelier plant-containers --crust <path>` で登録済み container と
  container/control/target root を一覧できます。
- `garelier plant-workfolder-validate --crust <path>` で registry と全登録
  container lock を検証できます。
- `garelier plant-add-container --crust <path> --container-id <id>
  [--container-path <path>]` は `crust-init` が使う低レベルの台帳追加操作です。
- `garelier plant-write-lock --crust <path> --lock <path> --container <id>
  --target-branch <branch> [--target-remote <url>]` は `container.lock.toml`
  を書きます。initializer はこの TS 実装を使います。
- `garelier plant-crust-validate --crust <path>` で `crust.toml` を検証できます。
- `garelier plant-lock-validate --crust <path> --lock <path>` で現在の台帳に
  対する container lock を検証できます。
- `dispatch_prepare.{sh,ps1}` と `dispatch_cleanup.{sh,ps1}` は
  `--target-root` / `-TargetRoot` を受け取ります。
- `merge_request.{sh,ps1}` は merge request に `target_root` を書き、
  merge gate はその場所で Git 操作を実行します。
- `garelier doctor --project <workfolder> --container <id>` で workfolder から
  health check を実行できます。container 内で実行する場合は通常
  `--container` は不要です。Plant-Crust では、doctor は
  `container.lock.toml` を正常扱いする前に `plant-lock-validate` を実行します。

workfolder に既存 `.gitignore` がある場合、`crust-init` は破壊的に編集しません。
`doctor` は `workfolder.git` に `*/target/` clone が載る危険がある ignore 設定を
警告します。

最小 `crust.toml` の形:

```toml
[plant]
kind = "crust"
schema_version = 1
workfolder_id = "my-workfolder"

[[containers]]
id = "client-a"

[[containers]]
id = "client-b"
path = "custom-dir"
```

`crust.toml` で有効なのは `[plant]` と `[[containers]]` だけです。
target branch / target remote / target path / policy は書かず、
`container.lock.toml` に持たせます。

container を workfolder 台帳から外す場合は、その `[[containers]]` ブロックを
削除します。container directory の archive/delete はユーザーが別途行います。
target checkout の詳細は各 container の `container.lock.toml` にあります。

`crust-init` が `crust.toml` へ container を追加した後に中断された場合は、
`--resume` で再開できます。`container.lock.toml` だけを書き直す場合は
`--repair-lock` を使います。

Plant-Crust v1 の `container.lock.toml` は意図的に厳格です。
`garelier_path` は `__garelier`、`target_path` は `target`、
`default_write_mode` は `patch` 固定です。

## Cross-Container PM

1つのPM sessionで複数の登録済みcontainerを調整できます。PMは `crust.toml`
を読み、各 `container.lock.toml` を検証し、各
`container_root/__garelier/<pm_id>/` を読み、必要なcontainerの
`runtime/dock/inbox/` に依頼を書きます。Dock はcontainer localの結果を
`runtime/dock/outbox/` に書き、PMがそれらを横断集約します。

複数containerをまたぐblueprintは、主対象となる起点containerに置きます。

```text
container-a/__garelier/<pm_id>/control/blueprints/cross-container-001.md
```

blueprintには対象containerを明記します。他containerには、起点blueprintを
参照するcontainer-local Dock requestを書きます。これにより、Dock以下は
sibling containerを読まず、PMだけがworkfolder全体を調整できます。
