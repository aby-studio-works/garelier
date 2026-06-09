# Request Schema

This file is the authoritative schema for `.garelier/request.toml`
files carried on `garelier/request/...` branches. Every accepted
request validates against it.

## Top-level fields (required)

| Field         | Type   | Notes                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------- |
| `request_id`  | string | `R-YYYYMMDD-NNNN-<short-slug>`. Globally unique. Stable across retries. |
| `short_uid`   | string | 6–8 lowercase hex chars. Random per request. Combined with `request_id` in branch name. |
| `source_pm`   | string | Issuer PM id (must appear in `allowed_sources.toml`).                  |
| `target_pm`   | string | Recipient PM id. MUST match the recipient's own id at validation time. |
| `kind`        | string | One of the values in `allowed_request_kinds.toml`.                     |
| `priority`    | string | `low` \| `normal` \| `high` \| `urgent`. Default `normal`.             |
| `created_at`  | string | ISO 8601 with timezone offset.                                         |

## Required sub-tables

### `[git]`

| Field             | Type   | Notes                                                                 |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `request_branch`  | string | Full branch name. MUST equal `garelier/request/<target_pm>/<source_pm>/<request_id>-<short_uid>`. |

### `[safety]`

Default to all false. The request must explicitly set the flags it
needs, and the recipient PM verifies each against the kind's
capability entry (per `capability_registry.toml`).

| Field                       | Type | Notes                                                            |
| --------------------------- | ---- | ---------------------------------------------------------------- |
| `allow_commits`             | bool | Permission to make commits on a workbench branch.                |
| `allow_promote`             | bool | MUST be `false`. Hard-rejected if `true`.                        |
| `allow_production_write`    | bool | Permission to mutate external data. Requires data-change guards. |

## Optional fields

| Field                     | Type   | Notes                                                          |
| ------------------------- | ------ | -------------------------------------------------------------- |
| `target_branch`           | string | Branch the work concerns (typically `studio`). Default `studio`. |
| `blueprint_path`          | string | For `implement_blueprint`: path inside the request branch.     |
| `done_when`               | string | Completion condition (e.g. `merged_to_remote_studio`).         |
| `[output]`                | table  | Per-kind output expectations (see below).                      |
| `[scope]`                 | table  | Optional scoping (e.g., subsystems, crates, paths).            |
| `[data_change_guards]`    | table  | Required when `safety.allow_production_write = true`.          |

### `[output]`

Boolean flags naming the report artifacts the requester expects to
receive. Validator rejects unknown keys.

| Field                    | Type | Notes                                              |
| ------------------------ | ---- | -------------------------------------------------- |
| `inspection_report`      | bool | Scout-style report.                                |
| `implementation_report`  | bool | Worker-style report (only for commit-bearing kinds). |
| `summary_report`         | bool | Top-level summary added to delegated_requests/.    |

## Forbidden fields

The following keys are **explicitly rejected** by the validator,
regardless of value:

- `command`
- `commands`
- `script`
- `shell`
- `exec`
- `run`
- `entrypoint`
- `arguments` / `args`
- `env` (the request cannot inject environment variables into the
  recipient's execution context)

Adding any of these turns the request into an arbitrary-shell
vehicle. The intake layer rejects the request and writes a
rejected-report so the issuer can see the violation.

## Allowed kinds (reference)

`allowed_request_kinds.toml` is canonical. The shape of each kind:

### `rerun_tests`

- `allow_commits = false`, `allow_promote = false`,
  `allow_production_write = false`.
- Required: nothing beyond top-level fields.
- Optional: `[scope]` with `crates = [...]`, `paths = [...]`, etc.
- Output: `inspection_report = true` (default), `summary_report`.

### `rerun_checks`

Same shape as `rerun_tests` but for static checks (linters, asset
validation, etc.).

### `run_scout_inspection`

- `allow_commits = false`, `allow_promote = false`,
  `allow_production_write = false`.
- Required: a free-text `purpose` field at top level describing the
  investigation, OR a reference to an existing blueprint via
  `blueprint_path`.
- Output: `inspection_report = true` (mandatory).

### `summarize_project_dashboard`

- All safety flags false.
- Optional: `[scope]` selecting which dashboard files to summarize.
- Output: `summary_report = true` (mandatory).

### `check_api_compatibility`

- All safety flags false.
- Required: `[scope] target_versions = ["..."]`.
- Output: `inspection_report = true`.

### `implement_blueprint` (default-disabled)

- `allow_commits = true`, `allow_promote = false`,
  `allow_production_write = false` by default.
- Required: `blueprint_path` referencing a file under the request
  branch's `.garelier/` directory.
- Required before issue: the source PM's `remote_pms.toml` entry for
  the target must set `allow_implementation = true`.
- Required on receive: the target PM's `capability_registry.toml` must
  enable `implement_blueprint`.
- Output: `implementation_report = true`, `inspection_report = true`.

### `update_docs` (default-disabled)

Same shape as `implement_blueprint` but restricted to documentation
paths declared in the recipient's `AGENTS.md` "Documentation paths"
section.

## Validation algorithm (informative)

1. Branch name parse:
   `^garelier/request/(?P<target>[^/]+)/(?P<source>[^/]+)/(?P<rid>R-[0-9]{8}-[0-9]{4}-[a-z0-9-]+)-(?P<uid>[a-f0-9]{6,8})$`.
2. Load `.garelier/request.toml`. Reject if absent or unparseable.
3. Reject if any forbidden field is present.
4. Cross-check: `target_pm == <target>`, `source_pm == <source>`,
   `request_id == <rid>`, `short_uid == <uid>`,
   `git.request_branch` equals the full branch name.
5. Reject if `target_pm` is not this PM's own id.
6. Reject if `source_pm` not in `allowed_sources.toml`.
7. Reject if `kind` not in `allowed_request_kinds.toml`, or if the
   kind entry has `allowed = false`.
8. Reject if `kind` not in this PM's capability registry.
9. Reject if `safety.allow_promote == true`.
10. If `safety.allow_production_write == true`, require
    `[data_change_guards]` to be present and complete.
11. Reject if `request_id` already exists in
    `__garelier/<pm_id>/runtime/requests/processed/` or
    `__garelier/<pm_id>/runtime/requests/inbox/` with a different commit SHA.
12. On accept, write
    `__garelier/<pm_id>/runtime/requests/inbox/<request_id>.toml`
    (normalized) and
    `__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-request-<request_id>.md`.
13. On reject, write
    `__garelier/<pm_id>/runtime/requests/rejected/<request_id>.toml` and
    `__garelier/<pm_id>/control/reports/requests/<request_id>-rejected.md`.
