# Status Web Console (read-only)

A local, browser-based view of a Garelier PM's current state — the live
dashboard, work queue, role status, reports, the Librarian knowledge trees, and
a project file tree with a Markdown viewer — so you can see what is happening
without reading runtime files or asking an AI to summarize. **Read-only** and
it **consumes no AI tokens**: it only reads files and serves them.

## First time here

Never used this console? Read it in this order — each step makes the next one
make sense:

1. **Dashboard** — start here. One glance tells you whether the PM is healthy,
   whether anything is blocked or rate-limited, and what is moving right now.
2. **Flow → Pipeline** — *what the moving parts mean*. One diagram shows the
   command chain (User → PM → Dock/Artisan → producers → merge gate → studio →
   promote), the two lanes, and every role. Read it once and the rest of the
   console falls into place. **Flow → Branches** then names each branch family.
3. **Work** — *what is happening now*. **Live** is the execution board, **Queue**
   is the full backlog (active vs held-future), **Reports** is what each role
   actually did.
4. **Knowledge / Control / Files** — *the source of truth*. Knowledge is the
   curated reading set, Control is the planning authority (roadmap / blueprints /
   decisions), Files is everything else, browsable.

Two ideas unlock the whole console:

- **commit vs report decides the role.** Worker / Smith / Librarian / Artisan
  produce commits; PM / Scout / Observer / Guardian / Wanderer do not. (Flow →
  Pipeline has the full table.)
- **held ≠ idle.** A role can be free while only *future-milestone* work is
  queued — that work is intentionally held by a milestone/dependency gate, not
  stuck. The `FUTURE QUEUE` is normal, not a problem.

Everything is **read-only**: nothing here dispatches, merges, or edits state, so
you can click freely while exploring.

## Starting and stopping it

From `skills/garelier-core/driver/`:

```bash
bun run status -- --pm-id <pm_id>
```

Or via the helper scripts (which write a pidfile so it can be stopped without
the launching terminal):

```bash
skills/garelier-core/scripts/start_status.sh --pm-id <pm_id> [--project /path]
skills/garelier-core/scripts/stop_status.sh --pm-id <pm_id>
skills/garelier-core/scripts/status_web_status.sh --pm-id <pm_id>   # is it up?
```

Then open the printed URL. On Windows, run these helpers from Git Bash.
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

It is read-only and side-effect-free: it never mutates Garelier state and
never spawns a provider CLI.

It also runs for a **control-only Garelier Control namespace** that has
`control/control.toml` but no `_pm/setup_config.toml`. In that mode, Work,
Agents, Branches, and Reports are naturally sparse; Control, Knowledge,
dashboard, graph, and Files remain available. The console does not upgrade the
namespace or start execution roles.

## Theme

A light/dark toggle and an EN/JP description toggle sit in the top bar; the
choices are remembered in the browser. Headings, role names,
states, and chips stay English so logs and runtime files match the UI; prose
and helper text can switch between English and Japanese. The default language is
**Japanese** and the default theme is **light**.

## What it shows

Everything is integrated into **seven views**; a view's sub-pages are pill tabs.

- **Dashboard** — the first screen for LAN watching: current health, rate-limit
  / blocker warnings, LAN-vs-loopback access mode, unified live work board
  (active queue, held future queue, working, review/gate, done), live agents,
  and recent reports in one place.
- **Work** — the detailed work surface, in five tabs:
  - **Live** — the execution board, role rail, and lane lock details.
    Execution is shown as roadmap -> active/unblocked milestones -> backlog
    items -> phases; multiple milestones can run when their prerequisites
    allow it, while later milestones stay visible but held by
    milestone/dependency gates until opened.
  - **Workflow** — PM-authored Pipeline packages from blueprints, with package
    id, role, dependencies, status, linked assignment/report artifacts, and
    recent dispatch events. It is a derived view and performs no dispatch.
  - **Queue** — active/unblocked milestone queue, held future milestone queue,
    in-flight assignments, tier congestion, and role capacity. Queue tables
    show 10 items per page and link each blueprint to its full Markdown
    content.
  - **Agents** — each configured role's stable slot id, provider, model,
    and STATE, plus live ephemeral producers, parked inventory, and a responsibility
    reference.
  - **Reports** — recent role reports; click a row to open the **full** report
    rendered as Markdown (not just the summary).
- **Knowledge** — the knowledge surface, in five tabs:
  - **Curated** — the Librarian-managed knowledge trees (engineering / quality /
    review / system / security / external operations), shown as a sortable column
    table (category / document / title / layer / path); click a row to open the
    document. The committed knowledge is summarized alongside the local-only
    working area, and a **knowledge graph** at the bottom connects categories,
    documents, role reading lists, sources, and routines, flagging any dangling
    references.
  - **By role** — the inverse index from `role_index.toml`, as a column table
    (role / tier / document / title / layer / path) of each role's `read_first`
    and `on_demand` documents; click a row to open the file, with missing-path
    visibility.
  - **Lens** — the shared lens registry as a column table (pack / role / group /
    status / label), with the default group of each pack marked; click a row to
    open the pack. A lens changes a role's judgment focus only, never its
    authority. Empty when no registry is configured (lenses are opt-in).
  - **Routines** / **Sources** — the Librarian's `routine_registry.toml` and
    `source_registry.toml`, each as a column table (the headers show even when
    empty). A **repo-file source** opens its target document on click, and a
    routine with a resolvable manual/target opens that file. No registered
    routines/sources yet is normal for older installs or projects where the
    Librarian has not standardized a repeatable procedure or approved a source.
- **Control** — a derived graph and canonical-contract validation view of this
  PM's tracked `control/` authority: dashboards, milestones, blueprints,
  decisions, operations, and other artifacts. The graph is generated from
  files; it is never hand-maintained.
- **Files** — a project file tree; click a file to open it in the **modal
  viewer** (the tree stays; there is no inline side pane). The set is the
  git-tracked/untracked files **plus this PM's `__garelier/<pm_id>/` subtree**
  (so runtime reports, inboxes, the manifest, blueprints, and STATE files are
  browsable). Space-separated filter terms are partial-match ANDed against the
  full path (for example, `docs md`). The role worktrees (`…/checkout/`) and
  `.git/` are pruned to keep it small. Markdown renders to HTML; other text
  (incl. source) shows escaped.
- **Flow** — in two tabs: **Pipeline**, a *static* explanation of the command
  chain and how work moves (lanes, roles, branches, the merge gate, promote;
  see `pipeline_flow.md`), and **Branches** — `target`, `studio`, the active
  branch, and every branch family (`satchel` / `workbench` / `anvil` /
  `shelf` / `spyglass` / `monocle` / `gavel` / `clipboard`) with owner role,
  lifetime, and the `garelier/<target-slug>/<pm_id>/…` namespace.
- **Guide** — this document, plus a **Diagnostics** tab: the warning surface
  and the check order to follow when the console looks idle or stuck.

## By situation — where to look

| You want to… | Look at |
| --- | --- |
| see whether anything is wrong right now | **Dashboard** — health + warnings |
| understand who does what, or a term like *satchel* / *gavel* | **Flow → Pipeline** (roles & chain), **Flow → Branches** (branch families) |
| know what a Worker / Smith actually changed | **Work → Reports** — click the row for the full report; then **Files** for the changed paths |
| see why the queue looks busy but nothing new starts | **Work → Queue** — items in *held future* wait for a milestone/dependency gate; that is by design, not a stall |
| find what a given role is told to read | **Knowledge → By role** — its `read_first` / `on_demand` list |
| read a blueprint, decision, or the roadmap | **Control**, or **Work → Queue** (each row links its blueprint) |
| check the practice/policy a role follows | **Knowledge → Curated**, or **Knowledge → Sources** (click a repo-file source) |
| react to a failed merge | **Dashboard** `failed_quality_gate`, then **Work → Reports** for the gate detail |
| figure out why the console looks stuck or idle | **Guide → Diagnostics** — warning surface + the order to check (lane → merge gate → role STATE) |
| open any project or runtime file | **Files** — filter by path (e.g. `docs md`), click to view |

### Mermaid diagrams (optional, offline)

` ```mermaid ` blocks render as diagrams when the local bundle is present, and
as plain diagram source when it is not — so the Flow page is readable either
way. The setup wizard vendors the bundle automatically; to add it by hand:

```bash
cd skills/garelier-core/driver && bun run vendor:mermaid
```

The bundle is served locally and is never committed to the repo.

## Warnings

- **stale_lane_lock** — `lane.lock` names an owner whose pid is dead; verify
  and clear it via PM (the console never deletes it).
- **failed_quality_gate** — the latest merge-gate result is `failed`.
- **dispatch_hold** — an explicit hold parks the backlog (intentional pause).
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
