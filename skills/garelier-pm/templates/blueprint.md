# Blueprint: {{title}}

<!--
  Path: __garelier/<pm_id>/control/blueprints/<slug>.md
  Owner: PM
  Readers: Dock (assigns or decomposes), Worker / Scout / Smith (executes)

  A blueprint describes any work to be done — a multi-feature initiative,
  a refactor, a one-off task, an investigation, a recurring process.
  Dock decides how to execute it (multi-phase decomposition vs.
  single-agent assignment). PM doesn't anticipate that decision.

  Sections below are reusable for any work shape. Replace, omit, or
  rename sections that don't apply. For example, a "run all tests
  and report" blueprint may have empty Functional Requirements and
  populated Acceptance Criteria + Inputs + Expected Outputs.
-->

## Identity

- Slug: `{{slug}}`
- Status: {{draft | active | paused | shipped | archived}}    <!-- paused (DEC-011) = active item temporarily withheld from Dock dispatch; unpause by flipping back to active. -->
- Priority: {{normal}}            <!-- critical | high | normal | low; DEC-010. Default normal. Dock picks higher priority first. -->
- Authored: {{YYYY-MM-DD}}
- Last revised: {{YYYY-MM-DD}}
- Linked milestone: `{{milestone_slug}}`
- Execution lane hint: {{artisan | dock | auto}}    <!-- DEC-017 / DEC-045. `artisan` = one agent end-to-end (satchel branch integrated into studio); `dock` = coordinated pipeline via studio; `auto` = PM decides at dispatch. Lanes are mutually exclusive. -->
- Preferred role hint: {{artisan | worker | scout | smith | librarian | auto}}    <!-- Within the dock lane, the role Dock should prefer. Ignored when the lane is artisan. -->
- Kills risk: {{R-NNN | milestone riskiest unknown | "-"}}    <!-- DEC-070 risk-first: the dashboard risk or milestone riskiest-unknown this work retires. While high/critical risks are open, dispatch prefers risk-killing items over comfort work; "-" when none. -->

## Goal

{{One paragraph. What success looks like, in user-facing terms.
  Avoid implementation language; describe outcomes.}}

## Context

{{Why this work matters. What it builds on. What it unblocks.
  This helps Dock make execution-shape decisions and helps
  the executing agent make trade-off decisions.}}

## Context pack

<!-- DEC-067: bake in what the executing agent needs so it never has to
     rediscover it — exact file paths (line anchors where stable), the
     invariants it must not break, and how to verify locally. Producers
     work in cold isolated worktrees; every fact left out of this section
     costs a re-derivation (and is where mid-tier producers drift).
     Omit only for purely investigative work.
     Feedback loop (DEC-071): the jig parks assignments left with {{...}}
     placeholders; producers report rediscovered facts under the report's
     "Context pack gaps"; retro_digest aggregates them at milestone close —
     recurring gaps mean THIS section was too thin. -->

- Entry points: {{path(:line) — what lives there}}
- Invariants: {{what must remain true after the change}}
- Local verify: {{command(s) the producer can run before the gate}}

## Functional requirements

<!-- Numbered list. Each item is a thing the system or deliverable
     must do or contain. May be empty for purely investigative work
     (use Acceptance criteria + Expected outputs instead). -->

1. {{requirement_1}}
2. {{requirement_2}}
3. {{...}}

## Non-functional requirements

<!-- Performance, security, compatibility, accessibility, etc.
     Use this section to make implicit constraints explicit. -->

- **Performance:** {{e.g., handles 10k entities at 60fps}}
- **Compatibility:** {{e.g., must work on Bevy 0.17.x}}
- **MOD compatibility:** {{e.g., must not break TOML mod loading}}
- **Determinism:** {{e.g., GPU compute must produce identical results across runs}}

(Replace or remove rows as appropriate for the project.)

## Acceptance criteria

<!-- Concrete, testable statements. Each is a pass/fail check.
     This is what Dock uses to verify Worker output. -->

1. {{criterion_1 — concrete, testable}}
2. {{criterion_2}}
3. (Default for code blueprints) `cargo check --workspace --locked` passes
4. (Default for code blueprints) `cargo test --workspace --locked` passes
5. (Project quality gate) {{from AGENTS.md §2}}

## Constitution check

<!-- DEC-067: AGENTS.md §0 principles, checked at authoring time AND by
     Guardian/Observer at gate time (a violation blocks, citing the
     P-number). Name each principle this work could plausibly touch and
     how it stays compliant; "none touched" is a valid entry when true. -->

- {{P-number}}: {{how this blueprint stays within it / "none touched"}}

## Out of scope

<!-- Items that look related but are explicitly NOT part of this blueprint.
     Without this section, scope creeps. -->

- {{out_of_scope_1}}
- {{out_of_scope_2}}

## Inputs

<!-- Files, data sources, external resources that the executing agent
     should read or consume first. -->

- `__garelier/<pm_id>/control/blueprints/{{related_blueprint}}.md` — {{relationship}}
- `{{path/to/source/file.rs}}` — {{why_relevant}}
- (External) {{api_or_resource}} — {{access_notes}}

## Expected outputs

<!-- Where deliverables land. Code work commits to workbench branches
     (Dock arranges merge). Non-code work writes an inspection to
     `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`
     for daily/high-volume outputs. -->

- For code work: branch `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`
  merging into `garelier/<target-slug>/<pm_id>/studio`, modifying {{paths}}.
- For post-merge hardening: branch `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>`
  merging into `garelier/<target-slug>/<pm_id>/studio`, modifying {{paths}}.
- For artisan work: branch `garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>`
  created from and merging into `garelier/<target-slug>/<pm_id>/studio` after the
  Artisan's own Guardian + Observer gates and quality / coverage audits (DEC-045;
  `satchel` never merges to `<target>` — promote to `<target>` is a separate
  PM-approved, Concierge-executed step), modifying {{paths}}.
- For librarian work: branch `garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`
  merging through Dock review; for docs / registry / runbook / internal
  knowledge updates, modifying {{paths}}.
- For investigations / reports: file at
  `__garelier/<pm_id>/control/inspections/{{category}}/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}-{{topic}}.md` following
  `templates/inspection.md` structure.
- For other deliverables: {{specify_path_and_format}}

## Source / routine mapping

<!-- For Librarian work (external-info sync or routine standardization).
     Omit / `n/a` for ordinary code or investigation blueprints. See the
     Librarian role: a routine's manual is the re-dispatch hook PM uses to
     re-run the same standardized work via the right role next time. -->

- Source ID: `{{source_id_or_n/a}}`            <!-- registered in the source_registry.toml knowledge registry -->
- Routine ID: `{{routine_id_or_n/a}}`          <!-- registered in the routine_registry.toml knowledge registry -->
- Target internal document: `{{path_or_n/a}}`
- Runbook / manual path: `{{path_or_n/a}}`
- Transform rule: `{{transform_rule_or_n/a}}`

## Data-change guards (required if this blueprint mutates external data)

<!--
  REQUIRED when the work writes to a database, mutates filesystem state
  destructively, calls a write-side production API, mutates payment /
  accounting state, sends real notifications, or destroys cloud
  resources. See __garelier/<pm_id>/control/operations/data_change_policy.md.

  Omit entirely if the blueprint is read-only or commit-only.
-->

- **Dry-run support:** {{the script accepts --dry-run; describe what it prints}}
- **Before / after counts:** {{required content of the report}}
- **Sample records:** {{number and selection criteria for changed records to show}}
- **Rollback plan:** {{describe OR "irreversible — user must explicitly approve"}}
- **User approval channel:** {{how the user will authorize each execution; recorded in __garelier/<pm_id>/_pm/history.md}}
- **Secret handling:** {{credentials path, env var, or "n/a"}}

## Dependencies

<!-- Other blueprints/milestones that must complete before this one. -->

- Depends on: `__garelier/<pm_id>/control/blueprints/{{prereq_blueprint}}.md` (status: {{status}})
- Blocks: `__garelier/<pm_id>/control/blueprints/{{downstream_blueprint}}.md`

## Open questions

<!-- Items the user hasn't decided yet. Each one becomes a future
     edit when answered. Empty when blueprint is fully ready. -->

- {{question_1}}
- {{question_2}}

## Revision history

- {{YYYY-MM-DD}} — Initial draft
- {{YYYY-MM-DD}} — {{change description}}
