# Status Web Console (read-only)

A local, browser-based view of a Garelier PM's current state — the live
dashboard, work queue, role status, reports, the Librarian knowledge trees, and
a project file tree with a Markdown viewer — so you can see what is happening
without reading runtime files or asking an AI to summarize. **Read-only** and
it **consumes no AI tokens**: it only reads files and serves them.

> This is the in-console **Guide** page. The same text ships with the
> `garelier-core` skill (`web_console.md`) and as a human copy at
> `docs/web_console.md`; keep them in sync.

## Starting and stopping it

From the driver directory:

```bash
bun run status -- --pm-id <pm_id>
```

Or via the helper scripts (which write a pidfile so it can be stopped without
the launching terminal):

```bash
skills/garelier-core/scripts/start_status.sh --pm-id <pm_id> [--project /path]
skills/garelier-core/scripts/stop_status.sh  --pm-id <pm_id>
skills/garelier-core/scripts/status_web_status.sh --pm-id <pm_id>   # is it up?
```

PowerShell variants (`start_status.ps1`, `stop_status.ps1`,
`status_web_status.ps1`) are at feature parity. Then open the printed URL.
Configure host/port/refresh in `[status_web]` of
`__garelier/<pm_id>/_pm/setup_config.toml`.

**Port auto-bump:** if the chosen port is busy, the server tries the next free
one (up to +40), so several PMs/projects on one machine each get their own
console without colliding. The startup line prints the actual port.

**LAN viewing is the default.** The console binds to a LAN-reachable address
(`0.0.0.0`) so another host on the same network can open the
`http://<lan-ip>:<port>/` URL. In the browser UI, PM id, full project path, and
LAN URLs/details are hidden by default for screenshot/social sharing and are
shown only after pressing the relevant Show button.
Set `[status_web] host = "127.0.0.1"` or pass `--loopback` to bind local-only.
A warning is printed because the dashboard and browsable files become readable
by anyone on the LAN — treat it as a trusted-network tool. Secrets are still
redacted (see Security).

It is safe to run alongside the driver: it does not claim the driver pid, does
not require `[autonomy]`, and never spawns a provider CLI.

It also runs for a **control-only Garelier Control namespace** that has
`control/control.toml` but no `_pm/setup_config.toml`. In that mode, Work,
Agents, Branches, and Reports are naturally sparse; Control, Knowledge,
dashboard, graph, and Files remain available. The console does not upgrade the
namespace or start execution roles.

## Theme

A light/dark toggle and an EN/JP description toggle sit in the top bar; the
choices are remembered in the browser (localStorage). Headings, role names,
states, and chips stay English so logs and runtime files match the UI; prose
and helper text can switch between English and Japanese. The default language is
**Japanese** and the default theme is **light**.

## What it shows

- **Dashboard** — the first screen for LAN watching: current health, rate-limit
  / blocker warnings, LAN-vs-loopback access mode, unified live work board
  (active queue, held future queue, working, review/gate, done), live agents,
  and recent reports in one place.
- **Work** — the detailed work surface: live board, active/unblocked milestone
  queue, held future milestone queue, in-flight assignments, tier congestion,
  role capacity, and lane lock details. Queue tables show 10 items per page and
  link each blueprint to its full Markdown content. Execution is shown as
  roadmap -> active/unblocked milestones -> backlog items -> phases; multiple
  milestones can run when their prerequisites allow it, while later milestones
  stay visible but held by milestone/dependency gates until opened.
- **Flow** — a *static* explanation of the command chain and how work moves
  (lanes, roles, branches, the merge gate, promote). See `pipeline_flow.md`.
- **Agents** — each configured role's stable slot id, provider, model, STATE,
  lease (pid alive/dead), and branch, plus a responsibility reference.
- **Branches** — `target`, `studio`, the active branch, and every branch family
  (`satchel` / `workbench` / `anvil` / `shelf` / `spyglass` / `monocle` /
  `gavel` / `clipboard` / `studio`) with owner role, lifetime, and the
  `garelier/<target-slug>/<pm_id>/…` namespace.
- **Reports** — recent role reports; click a row to open the **full** report
  rendered as Markdown (not just the summary).
- **Knowledge** — the Librarian-managed, **tracked/curated** knowledge trees
  under `docs/garelier/<category>/` (engineering / quality / review / system /
  security / external_operations; DEC-029), categorized with click-to-open,
  plus a summary of the **local-only** working area (`raw`/`cache`/`drafts`
  under `runtime/librarian/`; DEC-038) — the committed-vs-local split.
- **Role Knowledge** — the DEC-048 inverse index from
  `docs/garelier/knowledge/role_index.toml`, showing each role's `read_first`
  and `on_demand` documents with click-to-open file bodies and missing-path
  visibility.
- **Control** — a derived graph and canonical-contract validation view of this
  PM's tracked `control/` authority: dashboards, milestones, blueprints,
  decisions, operations, and other artifacts. The graph is generated from
  files; it is never hand-maintained.
- **Knowledge graph** — shown at the top of Knowledge. It connects categories,
  documents, role reading lists, registered sources, and routines/manuals, and
  reports dangling references/format drift. It contains metadata/pointers only,
  not document bodies, so an AI can narrow retrieval without bulk-reading the
  knowledge tree.
- **Routines / Sources** — the Librarian's `routine_registry.toml` and
  `source_registry.toml` if present. No registered routines/sources yet is
  normal for older installs or projects where the Librarian has not standardized
  a repeatable procedure or approved an external source.
- **Files** — a project file tree with a click-to-view pane. The set is the
  git-tracked/untracked files **plus this PM's `__garelier/<pm_id>/` subtree**
  (so runtime reports, inboxes, the manifest, blueprints, and STATE files are
  browsable). Space-separated filter terms are partial-match ANDed against the
  full path (for example, `docs md`). The role worktrees (`…/checkout/`) and
  `.git/` are pruned to keep it small. Markdown renders to HTML; other text
  (incl. source) shows escaped.

### Mermaid diagrams (optional, offline)

` ```mermaid ` fenced blocks render as **diagram source** when the local bundle
is absent. The Garelier setup wizard vendors the library during tool setup when
Bun is available and the bundle is missing (needs network that one time; no CDN
at runtime). Manual fallback:

```bash
cd skills/garelier-core/driver && bun run vendor:mermaid
```

This downloads `static/vendor/mermaid.min.js` (~3.3 MB), served locally. The
file is **gitignored and never committed** — its bundle includes elkjs
(EPL-2.0, weak copyleft), and keeping it out preserves Garelier's
MIT/permissive-only, copyleft-free policy. If absent, diagrams fall back to
source text and the Flow page stays readable.

## Warnings

- **stale_pid** — a `runtime/driver/pids/*.pid` lease exists but its process is
  not alive and it is not marked finished.
- **stale_lane_lock** — `lane.lock` names an owner whose pid is dead; verify
  and clear it via PM (the console never deletes it).
- **rate_limited** — provider output recently reported a session / usage limit.
- **failed_quality_gate** — the latest merge-gate result is `failed`.
- **unresolved_review** — e.g., a role is REPORTING without a `report.md`.

## Security and cost

- LAN-reachable by default; `--loopback` restricts to `127.0.0.1`.
- Read-only: it never writes runtime files and has no operation endpoints (no
  dispatch / abort / merge / lock-delete).
- The file viewer can only reach members of the browsable set (git files plus
  the `__garelier/<pm_id>/` subtree). Traversal is blocked by **membership +
  a realpath-containment check** (the resolved path must stay inside the project
  root) + **symlink skipping** in the subtree walk, so a symlink can't be used
  to escape. `.git/`, the role worktrees, gitignored secrets elsewhere, and
  secret-named files (`.env*`, `*.pem`, `*.key`, `id_*`, `*secret*`) are
  excluded outright. Docs and static assets stay on fixed allowlists.
- Markdown is rendered server-side with all text escaped before any markup (no
  `<script>` injection from a repo document); link hrefs are scheme-checked.
- Secrets (api keys, tokens, passwords, private keys) are redacted from any
  file content before it reaches the browser. Set `show_source_urls = false` to
  show only the host of registry URLs.
- PM id, full project path, and LAN URLs/details are screenshot-hidden by
  default in the UI; reveal buttons show them when needed.
- Viewing consumes **no** Claude / Codex tokens.

## Out of scope

No operation UI (dispatch, abort, resume, merge, retry, lock/pid deletion), no
remote access beyond the LAN bind, no authentication, no AI-generated
summaries. Those are deliberately deferred.
