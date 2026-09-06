# Garelier Control

This namespace uses schema 3, `plan_graph_markdown`.

- Markdown bodies and TOML front matter under `control/` are tracked authority.
- All eight required `project_dashboard/` files are tracked mixed authority;
  generated indexes are optional and only their explicit marker regions may be regenerated.
- Plan relations live in Roadmap, Milestone, and Backlog records; inverse
  relations are derived.
- Checkpoints preserve exact cross-session resume state.
- `runtime/control/` contains only disposable coordination and cache data.
- Common operations, request-intake, scheduling, delegation, and report policy
  files are installed directly as part of this schema-3 scaffold.

Read `skills/garelier-core/plan_graph_contract.md` before mutation.
