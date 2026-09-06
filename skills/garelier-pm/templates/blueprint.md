# Blueprint: {{title}}

<!--
  Path: __garelier/<pm_id>/control/blueprints/<slug>.md
  Owner: PM
  Readers: Dock/PM (validate and receive), all executing/reviewing roles (read and enforce)

  A blueprint describes any work to be done — a multi-feature initiative,
  a refactor, a one-off task, an investigation, a recurring process.
  When PM knows the intended routing, write Pipeline packages so Dock can
  validate and mechanically render role assignments. When PM cannot safely
  choose the routing, leave Pipeline packages absent and Dock uses the legacy
  decomposition path.

  Sections below are reusable for any work shape. Replace, omit, or rename
  optional sections that don't apply; `Output definition` is mandatory. For
  example, a "run all tests
  and report" blueprint may have empty Functional Requirements and
  populated Acceptance Criteria + Inputs + Output definition.
-->

## Identity

- Slug: `{{slug}}`
- Status: {{draft | active | blocked | verification | shipped | archived}}    <!-- schema-3 vocabulary; blocked and verification are not dispatchable. -->
- Priority: {{normal}}            <!-- critical | high | normal | low; DEC-010. Default normal. Dock picks higher priority first. -->
- Authored: {{YYYY-MM-DD}}
- Last revised: {{YYYY-MM-DD}}
- Linked milestone: `{{milestone_slug}}`
- Execution route hint: {{artisan | dock | pm_direct | auto}}    <!-- Per-task hint only; never a project default. `artisan` = single role on satchel; `dock` = Dock orchestration; `pm_direct` = DEC-093 lightweight route; `auto` = PM decides at dispatch. -->
- Preferred role hint: {{artisan | worker | scout | smith | librarian | auto}}    <!-- Within Dock orchestration, the role Dock should prefer. Ignored for the Artisan route. -->
- Model-hint: {{opus | sonnet | haiku | provider model id | omit}}    <!-- W-026 routing override. Consumed by model_routing.ts as layer 2 (below a --model flag, above the indicators). Omit to use the indicator default or PM-AI inheritance. Explicit flags are always forwarded verbatim; agreement ranges are advisory only. -->
- Effort-hint: {{low | medium | high | omit}}    <!-- W-026 effort override. Honored on the jig/Workflow path; the attended Agent tool has no effort param (model only). -->
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
     invariants it must not break, and how to verify locally. Roles
     work in cold isolated worktrees; every fact left out of this section
     costs a re-derivation (and is where mid-tier roles drift).
     Omit only for purely investigative work.
     Feedback loop (DEC-071): the jig parks assignments left with {{...}}
     placeholders; roles report rediscovered facts under the report's
     "Context pack gaps"; retro_digest aggregates them at milestone close —
     recurring gaps mean THIS section was too thin. -->

- Entry points: {{path(:line) — what lives there}}
- Invariants: {{what must remain true after the change}}
- Local verify: {{command(s) the role can run before the gate}}

## Functional requirements

<!-- Numbered list. Each item is a thing the system or deliverable
     must do or contain. May be empty for purely investigative work
     (use Acceptance criteria + Output definition instead). -->

1. {{requirement_1}}
2. {{requirement_2}}
3. {{...}}

## Non-functional requirements

<!-- Performance, security, compatibility, accessibility, etc.
     Use this section to make implicit constraints explicit. -->

- **Performance:** {{e.g., handles 10k entities at 60fps}}
- **Compatibility:** {{e.g., must remain compatible with <dependency> <version>}}
- **MOD compatibility:** {{e.g., must not break TOML mod loading}}
- **Determinism:** {{e.g., GPU compute must produce identical results across runs}}
- **External-platform verification (公式確認):** {{Y/N/N-A + URL — does any design decision here depend on external platform/tool behavior (harness / Claude Code / OS / third-party lib)? Y → confirm against official docs, cite spec + URL; N; N-A. In-repo observation is not spec. See references/debugging_discipline.md §6 / references/pm_playbook.md §9}}

(Replace or remove rows as appropriate for the project.)

## Test discipline

<!-- PM selects only the mode here. The actual practice lives in the
     Librarian-owned `quality/test_driven_development.md` knowledge document.
     Omit for read-only, investigation-only, or docs-only work. -->

- Code test mode: {{standard | tdd | test-first-waived}}    <!-- `tdd` = Worker/Artisan must follow red/green/refactor and report evidence. `standard` = normal project test strategy. `test-first-waived` requires a reason. -->
- Scope: {{new behavior | bug fix | refactor | test-only | other}}
- Waiver reason: {{required only when `test-first-waived`; otherwise "-"}}

## Lens selection

<!-- Optional. Lens Groups tune role judgment focus only; they never change
     authority, permissions, write paths, MUST BLOCK conditions, or handoff
     format. Omit role rows to use [lenses.defaults] from setup_config.toml. -->

- Source: {{defaults | explicit}}
- Worker: {{`worker.implementation:minimal_patch` | omit}}
- Scout: {{`scout.investigation:source_first` | omit}}
- Smith: {{`smith.integration:compatibility` | omit}}
- Librarian: {{`librarian.source:strict` | omit}}
- Guardian: {{`guardian.risk_control:strict` | omit}}
- Observer: {{`observer.review:architecture` | omit}}
- Artisan: {{`artisan.creation:interface_first` | omit}}

## Pipeline packages

<!--
  Optional for legacy blueprints, recommended for new blueprints when PM can
  name the intended routing. Each PP-N package is a bounded dispatch unit that
  `garelier-core/driver/src/pipeline_packages.ts` can validate and render into
  a role `assignment.md`.

  Use Pipeline packages for code changes, non-code routine work, investigations,
  and test-only runs. Keep the package wording role-neutral. Smith packages are
  delayed packages: dispatch them only after the covered Worker package has
  merged into studio and the merge SHA/window is known. TDD/Test discipline is
  valid only for Worker or Artisan packages.

  Existing public blueprints without this section remain valid. To scaffold a
  single-file migration, run:
  bun skills/garelier-core/driver/src/pipeline_packages.ts migrate --blueprint <path> --out <path>.migrated
  To audit a published project's whole blueprint directory before writing, run:
  bun skills/garelier-core/driver/src/pipeline_packages.ts migrate-tree --control __garelier/<pm_id>/control
-->

### PP-1 — {{bounded package title}}
- Role: {{worker | scout | smith | librarian | artisan}}
- Dispatch: {{immediate | after PP-N | after PP-N merged into studio | conditional}}
- Depends on: {{PP-N | -}}
- Touches (推奨記入): {{comma-separated path globs this package edits, e.g. `core/recipe/**, src/ui/hud.rs` — flows to dispatch_prepare --touches for the W-053 conflict check so parallel packages that edit the same files are flagged; "-" when unknown}}
- Trigger: {{required only when Dispatch is conditional; otherwise "-"}}
- Goal: {{one bounded package outcome}}
- Kind: {{code | investigation | test-only | routine | knowledge | hardening | external-check | data-change | other}}
- Inputs:
  - `{{path_or_source}}` — {{why this role needs it}}
- Allowed write paths:
  - {{omit for Scout; required for commit-producing Dock-orchestration roles}}
- Forbidden write paths:
  - `__garelier/**`
  - `.env*`
  - `infra/**`, `deploy/**`, `.github/workflows/**`
  - `migrations/**`
- Do:
  - {{role-local action}}
- Test discipline: {{standard | tdd | test-first-waived | omit for Scout/Smith/Librarian}}
- Scope: {{new behavior | bug fix | refactor | test-only | other | "-"}}
- Waiver reason: {{required only when `test-first-waived`; otherwise "-"}}
- Acceptance:
  - {{package-local pass/fail criterion}}
- Expected outputs:
  - {{destination kind only: register | verdict file | inspection | row body; concrete path belongs in the dispatch prompt}}
- Data-change guards:
  - {{copy required dry-run / rollback / approval guards when this package mutates external data; otherwise omit}}
- Notes:
  - {{compact role-specific note or "-"}}

## Acceptance criteria

<!-- Concrete, testable statements. Each is a pass/fail check.
     This is what Dock uses to verify overall blueprint completion. Package-local
     acceptance lives under `## Pipeline packages`; legacy blueprints may keep
     all acceptance criteria here. -->

1. {{criterion_1 — concrete, testable}}
2. {{criterion_2}}
3. (Default for code blueprints) The project's check command (per `[quality_gate]`) passes
4. (Default for code blueprints) The project's configured test command passes
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
- `{{path/to/source/file}}` — {{why_relevant}}
- (External) {{api_or_resource}} — {{access_notes}}

## Output definition

<!-- This section is the authority for WHAT every role emits. The dispatch
     prompt/task file supplies only the resolved slug/date-specific path.
     Never copy this section into the prompt. See
     garelier-core/references/blueprint-output-contract.md. -->

- Artifact kind: {{code | documentation | tests | inspection | control artifact}}
- Format:
  - Template: {{template path/name | none}}
  - Register: {{required shape | none}}
  - Commit plan: {{required shape | none}}
- Mandatory elements:
  - {{standalone review_sha | census denominator | executed counterfactual evidence | other required element}}
- Destination kind: {{verdict file | inspection | Backlog/row body | register}}
- Concrete path: resolved by the dispatch prompt/task file; not recorded here.

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
- **User approval channel:** {{how the user will authorize each execution; recorded as typed Evidence on the Backlog record}}
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

## Review sign-off

<!-- DEC-076 design-review record. Add this footer ONLY for a high-stakes
     design — a migration, a protected path, a new top-level key, a large diff,
     or an architecture/policy change (the [observer_policy] require_for_* set).
     Trivial designs omit the section entirely. Reviewer = a user-opted-in
     Wanderer, or a fallback Observer subagent (architecture_risk_review) when
     none is present. Iterate any REWORK_RECOMMENDED / BLOCK to a passing
     verdict, then fill the Verdict line BEFORE dispatch — dispatch_prepare
     warns (advisory) while this section is present with no recorded Verdict
     (W-067). Verdict tokens: PASS, PASS_WITH_NOTES, REWORK_RECOMMENDED, BLOCK,
     NO_OPINION. -->

- Reviewer: {{wanderer | observer}}
- Verdict: {{fill with one verdict token once reviewed — leave this placeholder until then}}
- Date: {{YYYY-MM-DD}}
- Reviewed ref: {{git SHA or blueprint revision that was reviewed}}
