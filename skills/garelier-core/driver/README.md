# Garelier coordination tooling

TypeScript + Bun package serving the **dispatch-only** execution model
(DEC-061/066). Despite the legacy directory name (`driver/`, kept so inbound
paths stay valid), the headless per-iteration driver was **deleted** under
DEC-066 — what lives here is the zero-LLM tooling around dispatch:

| Area | Entry | What it does |
| --- | --- | --- |
| Merge gate | `src/dispatch/dock_merge.ts` (`poll`/`status`), `src/merge_gate*.ts` | single-active, mechanical `git merge --no-ff` + quality gate via `scripts/merge-gate.{sh,ps1}`; verdict-or-reject request validation |
| Status Web | `src/status_web.ts` (`bun run status -- --pm-id <id>`) | read-only dashboard + JSON API + file viewer (see `web_console.md`) |
| Status CLI | (sibling) `../scripts/status.{sh,ps1}` | dispatch-native terminal snapshot |
| Config | `src/config.ts` | `setup_config.toml` loader/validation (incl. the `[jig]` block, DEC-062 — default-on) |
| Graphs | `../scripts/control_graph.ts`, knowledge graph builders | control/knowledge contract validation |
| Branch GC | `src/branch_gc.ts` | deletes leftover commit-free ephemeral branches (gavel/monocle/spyglass) |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- `git` on PATH

## Commands

```bash
bun install                 # once
bunx tsc --noEmit           # typecheck
bun test                    # unit tests
bun run status -- --pm-id <pm_id> [--project <root>]   # Status Web
bun run vendor:mermaid      # optional, offline diagram rendering
```

Provider CLIs are spawned only by dispatch helpers
(`../scripts/dispatch_codex_producer.{sh,ps1}`) using their normal local
login stores; no provider API key is managed here.
