# Plant-Crust External Management Layout

Plant-Crust is Garelier's external-management layout for projects where the
Garelier control plane should live outside the target repository.

## Layout

```text
<workfolder>/
├── crust.toml
└── <container>/
    ├── container.lock.toml
    ├── __garelier/
    └── target/
        └── .git/
```

The existing in-project layout remains Plant-Lithosphere:
`control_root == target_root`. In Plant-Crust, the workfolder is only the
container registry. A selected container is the control root and its `target/`
child is the target Git repository: `control_root != target_root`.
`workfolder/__garelier` is not created and is not a valid PM control root.

## Rules

- `target/__garelier` is forbidden.
- `workfolder/__garelier` is unused; do not create a central workfolder control
  plane.
- Each container has exactly one target checkout in v1.
- `crust.toml` is a minimal workfolder ledger: each container is just an
  `id`, plus an optional `path` when the directory differs from the id.
  `container.lock.toml` freezes target path, target branch, target remote, and
  policy.
- Dispatch and merge-gate runtime files stay under the container
  `__garelier/<pm_id>/runtime/`.
- Git worktree, branch, merge, and quality-gate operations run in `target/`.
- PM may read every registered container's `__garelier/<pm_id>/` and write
  per-container Dock requests. Dock, Worker, Scout, Smith, Librarian,
  Guardian, Observer, Artisan, and Concierge are active-container scoped.

## Git Ownership

`workfolder.git` and `target.git` have different jobs:

- `workfolder.git`: manages `crust.toml`, container-side
  `container.lock.toml` files, and container-side `__garelier/`
  control/runtime state.
- `target.git`: owns the target project branch and every Garelier execution
  branch, including `garelier/<target-slug>/<pm_id>/studio`,
  `workbench/...`, `anvil/...`, `shelf/...`, `satchel/...`, and ephemeral gate
  branches.

Do not create the `garelier/*` branch hierarchy in `workfolder.git`.

## Tooling

- `garelier crust-init --workfolder <path> --container-id <id>` creates the
  Crust descriptors and can run normal setup against `target/`. If
  `crust.toml` already exists, the new container is appended to the workfolder
  ledger; existing `[[containers]]` entries are preserved, and duplicate
  container ids fail.
- `garelier plant-resolve --start <path>` reports the active Plant mode and
  roots. From a workfolder root it reports registry scope, not a
  `workfolder/__garelier` control root.
- `garelier plant-containers --crust <path>` lists registered containers and
  their container/control/target roots for PM cross-container planning.
- `garelier plant-workfolder-validate --crust <path>` validates the registry
  and every registered container lock.
- `garelier plant-add-container --crust <path> --container-id <id>
  [--container-path <path>]` is the lower-level ledger operation used by
  `crust-init`.
- `garelier plant-write-lock --crust <path> --lock <path> --container <id>
  --target-branch <branch> [--target-remote <url>]` writes
  `container.lock.toml`; both shell initializers use this shared TS path.
- `garelier plant-crust-validate --crust <path>` validates `crust.toml`.
- `garelier plant-lock-validate --crust <path> --lock <path>` validates the
  container lock against the current ledger.
- `dispatch_prepare.{sh,ps1}` and `dispatch_cleanup.{sh,ps1}` accept
  `--target-root` / `-TargetRoot`.
- `merge_request.{sh,ps1}` writes `target_root` into the merge request, and the
  merge gate runs Git operations there.
- `garelier doctor --project <workfolder> --container <id>` runs health checks
  from a workfolder; running from inside a container usually needs no
  `--container`. In Plant-Crust, doctor runs `plant-lock-validate` before it
  treats `container.lock.toml` as healthy.

If the workfolder already has a `.gitignore`, `crust-init` does not edit it
destructively. `doctor` warns when the workfolder ignore rules do not protect
`*/target/` clones from `workfolder.git`.

Minimal `crust.toml` shape:

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

Only `[plant]` and `[[containers]]` are valid in `crust.toml`. Do not put
target branch, target remote, target path, or policy there; those belong to
`container.lock.toml`.

To detach a container from the workfolder ledger, remove its `[[containers]]`
block. The container directory can then be archived or deleted separately by the
user; the target checkout details live in that container's `container.lock.toml`.

If `crust-init` is interrupted after the container was added to `crust.toml`,
rerun with `--resume`. To rewrite only `container.lock.toml`, use
`--repair-lock`.

In Plant-Crust v1, `container.lock.toml` is intentionally strict:
`garelier_path` must be `__garelier`, `target_path` must be `target`, and
`default_write_mode` must be `patch`.

## Cross-Container PM

One PM session can coordinate multiple registered containers. The PM reads
`crust.toml`, validates each `container.lock.toml`, reads each registered
`container_root/__garelier/<pm_id>/`, and writes requests into the chosen
container's `runtime/dock/inbox/`. Dock writes container-local results under
`runtime/dock/outbox/`; the PM aggregates those results across containers.

Cross-container blueprints live in a chosen origin container, normally the
primary affected container:

```text
container-a/__garelier/<pm_id>/control/blueprints/cross-container-001.md
```

The blueprint must name its affected containers. Other containers receive
container-local Dock requests that reference the origin blueprint. This keeps
Dock and subordinate roles from reading sibling containers while still allowing
the PM to coordinate the whole workfolder.
