# AGENTS.md

This file documents project-specific rules that supplement the Garelier
framework. Every Garelier agent (PM, Dock, Worker, Scout, Smith,
Artisan, Librarian, Observer) reads this file at startup and obeys its
rules in addition to the framework's defaults.

## 0. Principles (constitution)

Non-negotiable project principles. Every blueprint declares it does not
violate them (Blueprint template "Constitution check"); Guardian and
Observer treat a violation as blocking and cite the principle number.
Keep the list SHORT (≤7) — these are principles a gate can check a diff
against, not conventions (§10) or style.

- P1. Observable behavior changes only when the assignment explicitly
  says so; otherwise changes are behavior-neutral and prove it.
- P2. No new external dependency, license, or external write surface
  without a recorded decision.
- P3. Tests prove the change (red→green for fixes); a test is never
  weakened, skipped, or deleted to make a gate pass.

<!-- Add project-specific principles as P4..P7, e.g.:
     "P4. Determinism: snapshot-parity gates are never waived."
     "P5. Public API shapes change only via an accepted DEC." -->

## 1. Project identity

- Project name: {{project_name}}
- Target branch: `{{target_branch}}` (slug: `{{target_slug}}`)
- Primary language(s): {{e.g., Rust, TypeScript, Python}}
- Build command(s): {{e.g., cargo build, npm run build}}
- Test command(s): {{e.g., cargo test, npm test}}
- Asset check command(s) (optional): {{e.g., a project-specific asset/integrity check, or none}}

## 2. Quality gate

These commands must pass before Dock merges any workbench or Anvil branch into
the integration branch (`garelier/{{target_slug}}/{{pm_id}}/studio`):

```
{{quality_gate_command_1}}
{{quality_gate_command_2}}
```

If any command fails, Dock writes a `review.md` with the failing
output and transitions the Worker or Smith to `REWORK`.

### Runtime verification (compile + tests are not enough for runtime effects)

The quality gate above verifies that code COMPILES and that unit/scoped tests
pass — i.e. LOGIC correctness. It does NOT verify a change's RUNTIME EFFECT.

When a task's acceptance is a runtime effect — visual/rendering output, cross-
system or scheduling/timing behaviour, GPU/device behaviour, deploy/health, or
any "the running app actually does X" — compile + unit/scoped tests are
NECESSARY BUT NOT SUFFICIENT (a plausible-but-wrong fix can compile and pass
unit tests while the runtime effect stays broken). Such a task is verified by an
ACTUAL RUN, by one or both of:

- a project-defined **functional smoke RUN** that exits non-zero on failure —
  add it to `[quality_gate] merge_gate_commands` and/or the Smith batch so it
  gates automatically. Example: `app --headless --smoke`, `npm run e2e`, or `pytest -m smoke`.
- a **post-merge RUN-verify by a Scout** (commit-free): it RUNS the integrated
  studio build and produces an artifact (log / screenshot / health output) under
  `control/inspections/`, which PM reviews before closing the task. Use this when
  the effect needs human/AI judgement (e.g. visual output) rather than a binary
  pass/fail.

A runtime-effect task is NOT "done" on compile + unit-test alone. A Worker that
cannot RUN the integrated binary in its dispatch worktree (e.g. shared build
cache / no display) must SAY SO in its report and add the strongest scoped/
integration test it can; PM/Dock then dispatch the post-merge RUN-verify before
accepting the task. Blueprints for runtime-effect work state the run-verify
method in their Acceptance section.

## 3. Restricted files (禁則ファイル)

These files have a single responsible Worker (the "Lead Owner"). Other
Workers and Smiths must not edit them unless the assignment explicitly
names the file. Editing requests go through Dock.

| File or pattern                          | Lead Owner    | Notes                |
| ---------------------------------------- | ------------- | -------------------- |
| {{file_path_or_glob}}                    | {{worker_id}} | {{reason}}           |

Examples (replace with project-specific entries):
- the dependency manifest (`package.json` / `Cargo.toml` / `pyproject.toml` / …) — Human only — dependency changes need user approval
- `path/to/central_data_file`                — worker-01   — central data file, conflict-prone
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

## 10. Project-specific conventions

<!-- Add anything that's unique to this project: coding style guides,
     commit message format, branch naming additions, file layout
     constraints, etc. Keep entries short and actionable. -->

- {{convention_1}}
- {{convention_2}}

## 11. Escalation contacts

- Blueprint ambiguity: PM
- Quality gate failures: Dock (handles automatically; only escalate if rejection rate exceeds 50%)
- Build infrastructure failures: Human (PM relays to user)
