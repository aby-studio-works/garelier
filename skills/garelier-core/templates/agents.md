# AGENTS.md

This file documents project-specific rules that supplement the Garelier
framework. Every Garelier agent (PM, Dock, Worker, Scout, Smith,
Artisan, Librarian, Observer) reads this file at startup and obeys its
rules in addition to the framework's defaults.

## 1. Project identity

- Project name: {{project_name}}
- Target branch: `{{target_branch}}` (slug: `{{target_slug}}`)
- Primary language(s): {{e.g., Rust, TypeScript, Python}}
- Build command(s): {{e.g., cargo build, npm run build}}
- Test command(s): {{e.g., cargo test, npm test}}
- Asset check command(s) (optional): {{e.g., cargo run --bin check_assets}}

## 2. Quality gate

These commands must pass before Dock merges any workbench or Anvil branch into
the integration branch (`garelier/{{target_slug}}/{{pm_id}}/studio`):

```
{{quality_gate_command_1}}
{{quality_gate_command_2}}
```

If any command fails, Dock writes a `review.md` with the failing
output and transitions the Worker or Smith to `REWORK`.

## 3. Restricted files (禁則ファイル)

These files have a single responsible Worker (the "Lead Owner"). Other
Workers and Smiths must not edit them unless the assignment explicitly
names the file. Editing requests go through Dock.

| File or pattern                          | Lead Owner    | Notes                |
| ---------------------------------------- | ------------- | -------------------- |
| {{file_path_or_glob}}                    | {{worker_id}} | {{reason}}           |

Examples (replace with project-specific entries):
- `Cargo.toml` (workspace root)              — Human only — dependency changes need user approval
- `assets/data/products.toml`                — worker-01   — central data file, conflict-prone
- `assets/data/sequencer/*.toml`             — worker-02   — narrative scripts

## 4. Branch protection

The target branch (`{{target_branch}}`, e.g., `main`) is user-owned.
Garelier modifies it only on explicit user instruction, executed by Concierge
after PM approval.
Worker, Dock, Artisan, and PM never merge or push to it directly.

`garelier/{{target_slug}}/{{pm_id}}/studio` is the shared integration branch:
Dock integrates dock-lane output, and Artisan integrates its gated `satchel`
output in the artisan lane. Workers commit on their workbench branches locally;
Dock reads
the workbench refs from the shared `.git/` and performs the merge —
no `git push` is required for this hand-off.
Smiths commit on local Anvil branches after Dock has merged Worker
output into studio; Dock merges Anvil back into studio.

**Garelier branches are local-only.** Neither
`garelier/{{target_slug}}/{{pm_id}}/studio` nor any
`garelier/{{target_slug}}/{{pm_id}}/workbench/#<id>/<slug>` or
`garelier/{{target_slug}}/{{pm_id}}/anvil/#<id>/<slug>` is ever pushed to
the remote (see `garelier-core/protocol.md` §6.5). They encode
machine-local coordination state; pushing them prevents another
developer from running Garelier on the same project.

When the user requests a promote (formerly "release"), PM records approval and
dispatches Concierge to merge `garelier/{{target_slug}}/{{pm_id}}/studio` into
the target branch. Promote is the only Garelier operation that pushes to the
remote, and what it pushes is the user's `<target>` branch (not studio).

## 5. Persistent project authority

This project's persistent authority lives under `__garelier/{{pm_id}}/control/`:

- `control/project_dashboard/` — current, roadmap, backlog, decisions, risks, quality_gates, notes
- `control/operations/` — runbook, promote_checklist, recovery, data_change_policy
- `control/blueprints/` — PM specifications
- `control/inspections/` — accepted Scout inspections
- `control/delegation/` — remote PM registry and capability boundaries
- `control/request_intake/` — request branch schema and intake policy
- `control/scheduled_jobs/` — RRULE job definitions owned by Garelier
- `control/reports/` — promote / benchmark / data_audit / request archives

All roles read these files. Only PM writes to most of them. Scout
drafts inspections in its detached worktree, then PM commits accepted
copies under `inspections/`; Worker / Scout / Smith write reports under `reports/`.

The `__garelier/{{pm_id}}/runtime/` tree is transient (inbox, manifest, escalation).
Do not promote runtime files into long-term decision-making artifacts.

For daily/high-volume operation, follow `garelier-core/retention.md`:
PM rotates `_pm/history.md` into monthly archives, high-volume
inspections use `control/inspections/<category>/YYYY/MM/`, and runtime
archives are pruned only by their owning role.

## 6. Compact handoff

Role-to-role files are compact by default: `assignment.md`, `report.md`,
`questions.md`, inbox notifications, manifest activity, and runtime backlog
entries use short factual lines and pointers to source files. User-facing
answers and project documentation stay normal unless explicitly scoped as
runtime handoff.

## 7. Data-change policy

Any task that mutates external data (database writes, destructive
filesystem, write-side production API, payments, real notifications,
cloud-resource destruction) must follow
`__garelier/{{pm_id}}/control/operations/data_change_policy.md`. This binds
PM authoring, Worker execution, and Dock's merge gate.
Smith execution follows the same data-change policy when an integration
hardening assignment would mutate external data.

Allowlisted operational emails from `control/scheduled_jobs/` are
audited under `control/reports/notifications/` and must not be used for
customer-facing messages.

## 8. Bilingual policy

{{e.g., Specification documents are bilingual JP/EN. Code comments are
English only. Variable names are English. Issue descriptions may be
Japanese.}}

## 9. Web search policy

Workers may use web search for API/syntax lookups within their task
scope. Workers must NOT use web search for broad investigations; those
go to Scout via Dock escalation.

Smiths may use web search for narrow integration, release, dependency,
license, or API checks within their task scope. Broad market or policy
research goes to Scout or PM via Dock escalation.

Scouts may use web search freely within the scope of their assignment.

Neither Workers, Scouts, nor Smiths may submit project-internal blueprints,
unreleased plot points, or other confidential content to web services.

## 9. Project-specific conventions

<!-- Add anything that's unique to this project: coding style guides,
     commit message format, branch naming additions, file layout
     constraints, etc. Keep entries short and actionable. -->

- {{convention_1}}
- {{convention_2}}

## 10. Escalation contacts

- Blueprint ambiguity: PM
- Quality gate failures: Dock (handles automatically; only escalate if rejection rate exceeds 50%)
- Build infrastructure failures: Human (PM relays to user)
