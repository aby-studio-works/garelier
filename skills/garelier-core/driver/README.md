# Garelier coordination tooling

TypeScript + Bun package serving the **dispatch-only** execution model
(DEC-061/066). Despite the legacy directory name (`driver/`, kept so inbound
paths stay valid), the headless per-iteration driver was **deleted** under
DEC-066 — what lives here is the zero-LLM tooling around dispatch:

## Implementation contract

Production helper logic is TypeScript in `src/` and requires Bun 1.4.0 or
later. Stable CLI entrypoints are invoked directly with `bun <path>.ts`.
There are no shell compatibility shims; the framework's one shell file is the
latency-only `../hooks/task_mirror_hook.sh` PostToolUse pre-filter.

| Area | Entry | What it does |
| --- | --- | --- |
| Merge gate | `src/dispatch/dock_merge.ts` (`poll`/`status`), `src/merge_gate*.ts` | single-active, mechanical `git merge --no-ff` + quality gate via `driver/src/scripts/merge-gate.ts`; verdict-or-reject request validation |
| Status Web | `src/status_web.ts` (`bun run status -- --pm-id <id>`) | read-only dashboard + JSON API + file viewer (see `web_console.md`) |
| Status CLI | `src/dispatch/dock_status.ts` | dispatch-native terminal snapshot |
| Config | `src/config.ts` | `setup_config.toml` loader/validation (incl. the `[jig]` block, DEC-062 — default-on) |
| Pipeline packages | `src/pipeline_plan.ts`, `src/readonly_assignment_prep.ts`, `src/role_pickup_pack.ts` | validate/plan PM-authored packages, prep read-only Scout assignments, and write advisory pickup maps |
| Review prep | `src/review_gate_prep.ts` | writes Observer/Guardian/Smith review briefs and Guardian scan draft paths before a gate/review |
| Role diet | `src/role_doc_diet.ts` | warning-only role prompt/reference size + compact-hook audit |
| Graphs | `../scripts/control_graph.ts`, knowledge graph builders | control/knowledge contract validation |
| Branch GC | `src/branch_gc.ts` | deletes leftover commit-free ephemeral branches (gavel/monocle/spyglass) |

## Prerequisites

- [Bun](https://bun.ts) ≥ 1.3
- `git` on PATH

## Commands

Dependencies must already exist; a missing local dependency fails closed.

```bash
node ./node_modules/typescript/lib/tsc.js --noEmit  # local-only typecheck; missing dependency fails
bun test                    # unit tests
bun run status -- --pm-id <pm_id> [--project <root>]   # Status Web
bun run vendor:mermaid      # optional, offline diagram rendering
```

Provider CLIs are spawned only by dispatch helpers
(`../driver/src/scripts/dispatch_provider.ts`) using their normal local
login stores; no provider API key is managed here.
