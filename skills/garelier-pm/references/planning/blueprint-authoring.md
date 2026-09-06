# Garelier PM Blueprint Authoring Reference

## §4. Blueprint authoring

When the user describes any new piece of work — whether it's a
multi-feature initiative, a refactor, a one-off task, an investigation,
or a recurring process — translate it into a blueprint.

Resolve `control.toml` before authoring. Schema v3 accepts template-based
Markdown content after strict validation, but Blueprint status changes use
`control transition blueprint <slug> --to <status> --session <id>
--expect-control-revision <revision>`; direct status edits are drift. Schema
v1/v2 and unknown formats are rejected explicitly.

PM does **not** split user-facing requests into separate "workflow" documents.
A blueprint is the written description of work to be done with clear acceptance
criteria. For public/backward compatibility, old blueprints may omit routing and
Dock will still use the legacy decomposition path. For new blueprints, when PM
knows the intended role routing, write `## Pipeline packages` so Dock can
validate and mechanically render role `assignment.md` files.

- The user-facing interface stays uniform: "describe what you want, PM writes a
  blueprint, milestone tracks completion."
- PM records routing intent when it is known (Worker / Scout / Smith /
  Librarian / Artisan), including non-code, routine, and test-only work.
- Dock validates the package shape, expands it into assignments, dispatches,
  tracks progress, and manages gates.
- Dock may still re-evaluate or escalate when the package contradicts current
  studio state, role boundaries, protected paths, or missing information.

### 4.1 Process

1. Listen to the user's intent.
2. Ask clarifying questions about scope, constraints, success criteria,
   inputs, and out-of-scope items. Do not start writing until the goal
   is clear.
   - If `[autonomy] auto_approve_blueprints = true`, **do not ask
     clarifying questions interactively**. Instead, write your best
     interpretation into the blueprint and record open questions in
     the blueprint's `Open questions` section. Dock may escalate
     later if the gaps block execution.
3. If the user's intent is a data-changing task (database mutation,
   filesystem destruction, write-side production API, etc.), fill in
   the blueprint's `Data-change guards` section per
   `__garelier/<pm_id>/control/operations/data_change_policy.md`. Without
   this, Dock will reject the merge.
3a. If the user requests TDD/test-first work, set the blueprint's
   `Test discipline` mode to `tdd`. If the work is code-producing but
   not test-first, use `standard`; if test-first is intentionally waived,
   use `test-first-waived` and record the reason. Do not write the TDD
   procedure into the blueprint; the rules live in
   `quality/test_driven_development.md`.
3b. (Optional, DEC-067) When more than one credible approach exists for a
   non-trivial feature, diverge BEFORE binding: record 2-3 approaches with
   trade-offs in `templates/design_options.md` and preserve the reviewed result
   in the schema-3 Blueprint body. The Workflow
   judge-panel pattern fits for generating them independently. The chosen option feeds
   step 4; rejected options stay on record so they are not re-litigated.
   Skip for obvious or DEC-constrained approaches — never pad.
4. Draft the blueprint body using `templates/blueprint.md`. Create or edit the
   canonical schema-3 Markdown, strict validate it, and use `control transition
   blueprint` for status changes. Fill the
   `Context pack` section (exact paths, invariants, local verify) and the
   `Constitution check` against AGENTS.md §0 (DEC-067) — Guardian/Observer
   block on principle violations at gate time. Fill `Output definition` with
   artifact kind, format/template/register/commit-plan shape, mandatory
   elements, and destination kind. Do not put the resolved slug/date-specific
   output path there; the dispatch prompt/task file owns that routing value.
   If PM knows the dispatch shape, fill `Pipeline packages`:
   - Use one `PP-N` package per bounded role assignment.
   - Use `Role: scout` for investigations, read-only external checks, daily
     reports, and test-only runs that produce an inspection/report.
   - Use `Role: worker` for commit-producing implementation/refactor/test-code
     work.
   - Use `Role: smith` only as a delayed post-merge hardening package
     (`Dispatch: after PP-N merged into studio`).
   - Use `Role: librarian` for registered knowledge, runbook, routine, and
     registry updates.
   - Use `Role: artisan` only when the Artisan Artisan route should carry the package
     end to end.
   - Validate or scaffold with
     `bun skills/garelier-core/driver/src/pipeline_packages.ts validate --blueprint <path>`
     or `... migrate --blueprint <path> --out <path>.migrated`.
   - For public-project upgrades, audit existing blueprints with
     `bun skills/garelier-core/driver/src/pipeline_packages.ts migrate-tree --control __garelier/<pm_id>/control`.
     The command is dry-run by default; add `--write` only after review.

   **→ Design-review gate (DEC-076) — non-trivial designs only.** When the draft
   is non-trivial (large diff / new top-level key / protected path /
   architecture / policy change; trivial blueprints skip it), get an
   INDEPENDENT review + sign-off BEFORE finalizing. Wanderer use is
   **user-opt-in only**: the PM never launches a Wanderer unless the user
   explicitly says to launch/use one. If a user-launched Wanderer is present,
   run `bun <garelier-core>/driver/src/peer/wanderer_review.ts --project <root> --pm-id <id> --doc control/blueprints/<slug>.md`.
   If no Wanderer is present, the Wanderer is rate-limited/unavailable, or the
   command returns `outcome=fallback_observer`, request an **Observer subagent**
   review (`architecture_risk_review`) instead.
   A Wanderer reply counts only when it contains one canonical verdict token:
   `PASS`, `PASS_WITH_NOTES`, `REWORK_RECOMMENDED`, `BLOCK`, or `NO_OPINION`.
   Resolve any `REWORK_RECOMMENDED`/`BLOCK`; iterate to
   `PASS`/`PASS_WITH_NOTES`. Record `reviewer + verdict + date + reviewed ref`
   in the blueprint's `## Review sign-off` footer (scaffolded in the blueprint
   template; add it only for a high-stakes design, omit it for trivial ones).
   As a reachability backstop (W-067), `dispatch_prepare.ts` emits an advisory
   warning when a blueprint declares that footer but its `Verdict:` line is
   still unfilled — so dispatching from an unreviewed high-stakes design is
   surfaced, not silent. This gate is **NOT** collapsed by
   `auto_approve_blueprints`. Then continue.
5. **User confirmation step.** If `[autonomy] auto_approve_blueprints
   = true`, skip this step and proceed directly to step 6 (record the
   autonomous approval on the Backlog record, see §15). Otherwise,
   show the draft to the user and iterate until approved.
6. In schema v3, link the Blueprint to its Backlog, Decision, and Milestone
   graph records, strict validate, and activate it through `control transition
   blueprint <slug> --to active --session <id>
   --expect-control-revision <revision>`. If
   `[autonomy] auto_approve_milestones = true` and the
   milestone needs creating, create it without confirmation.
7. The Blueprint record itself carries the state (`draft` / `active` /
   `verification` / `shipped` / `archived`); an auto-approved blueprint records
   that it was approved autonomously in its Backlog Evidence.
8. Commit the exact persistent files reported by the successful transaction
   plus PM history:
   ```bash
   git add <transaction-reported-control-files>
   git commit -m "blueprint: <short description>"
   ```

### 4.2 Quality bar for blueprints

A good blueprint is **executable** — Dock can act on it without
further user input. This means regardless of whether the work will
become a multi-phase milestone or a single-agent assignment:

- Acceptance criteria are concrete and testable.
- Inputs are listed (other blueprints, code paths, design docs,
  external sources, files).
- Out-of-scope items are explicit (avoids scope creep at execution
  level).
- Dependencies on other blueprints/milestones are stated.
- `Output definition` specifies every deliverable's artifact kind, format,
  mandatory elements, and destination kind. The resolved concrete path is
  deliberately absent and is supplied by the dispatch prompt/task file.
- For code-producing tasks, `Test discipline` says whether the Worker/Artisan
  should use normal testing, TDD, or a recorded test-first waiver.
- When PM knows the routing, `Pipeline packages` name the intended role,
  dispatch timing, inputs, allowed write paths (commit-producing roles),
  package-local acceptance, and output destination kinds. This applies to code,
  investigations, routine/knowledge updates, external checks, and test-only
  runs.
- For data-changing tasks, the `Data-change guards` section is
  filled.

If you cannot make a blueprint executable without more info, ask more
questions. Do not write a vague blueprint hoping Dock will fill
in.

### 4.3 Blueprint scope: the spectrum

Blueprints cover a wide range of work. A few examples to calibrate:

| User's request                                | Blueprint is the shape |
| --------------------------------------------- | ---------------------- |
| "Add a settings page with theme switcher"     | Multi-feature: acceptance criteria for each sub-feature, dependency notes |
| "Refactor the auth module"                    | Refactor: scope of files, behavior preservation criteria |
| "Run a full test pass and report failures"    | Single task: input branch, report format/mandatory evidence, register destination kind |
| "Check our quarterly tax filing"              | Investigation: source documents, output inspection format and mandatory elements |
| "Upgrade <framework> from <v1> to <v2>"       | Single task: target version, breakage criteria, rollback plan |
| "Survey the top 5 GPU compute crates"         | Investigation: criteria, output inspection structure |
| "Migrate user emails to lowercase in prod DB" | Data-change: dry-run, rollback, counts, samples, user approval |

Same template (`blueprint.md`), same authoring process. When the blueprint has
Pipeline packages, Dock treats them as PM-authored routing intent and validates
them before assignment generation. When the section is absent, Dock keeps the
legacy decomposition responsibility.

### 4.4 Blueprint queue hold — drain mode (DEC-011)

There are moments when the user wants Dock to **stop
dispatching new work** without abandoning queued items. Common
triggers:

- "I want to promote / release. Don't start new work that lands on
  studio in the middle of it."
- "I'm restructuring the roadmap. Hold dispatches until I'm done."
- "Step away — finish current work and idle."

In schema v3, change the queue gate with `control transition blueprint <slug>
--to blocked --session <id> --expect-control-revision <revision>` and record the
drain reason in the Blueprint body. Pass expected revisions and record the
reason/evidence; commit on studio. Never flip status metadata in an editor.

What a queue hold does and does not do:

| Aspect                          | Queue-hold behavior |
|---------------------------------|----------------|
| Dock dispatches new work?  | **No** — blocked schema-v3 blueprints are skipped in §4.0 sort. |
| Already-dispatched assignment?  | **Continues to completion.** The status change is queue-only, not a kill switch. |
| Merge gate already in flight?   | **Proceeds normally.** Studio merge lands as usual. |
| Workers go IDLE naturally?      | Yes; they finish current task, transition IDLE, then idle indefinitely (Dock has no active work to dispatch). |

To abort an in-flight Worker, use §13.2 clean-stop — that's the
explicit Worker-interrupt path, distinct from a Blueprint queue hold.

To resume in schema v3, transactionally move `blocked → active` with the new
Control revision. Dock's
next iteration picks it up subject to normal priority + milestone sort.

**Typical drain workflow:**

1. User: "release準備、新規 dispatch 止めて。"
2. PM: query all currently active, not-yet-dispatched Backlog/Blueprint relations.
   Transition each through the schema-v3 Blueprint transaction. Commit:
   `chore(pm): hold N blueprints for release prep`.
3. Workers complete current tasks → IDLE. Dock emits "no
   action" iterations.
4. Once IDLE is reached system-wide, do the release work (§7
   promote, roadmap edits, etc.).
5. Done? PM resumes: transition `blocked → active` (schema v3/v2), commit
   `chore(pm): resume blueprints post-release`.
6. Dock dispatch resumes within ~60s (next poll).

Drain hold is one revision-checked transition per Work/Blueprint plus a single
commit. No special driver mode and no abort. Runtime claim/session records are
transient and are not committed.

### 4.5 Autonomous mode: drafting from milestones

When `[autonomy] enabled = true` and no fresh user intent arrived
this iteration (no new inbox notification, no manual edit you can
detect), draft pending blueprints from the existing milestone backlog:

1. Use schema-3 bounded resume plus `control list/get` to retrieve active
   Milestones and their planned Backlog/Blueprint relations. Never scan the
   control tree.
2. For each active Milestone, query planned relations and identify entries
   without a linked Blueprint.
3. Pick the highest-priority unchecked entry (top-most in the
   milestone's Blueprints section; if two milestones have candidates,
   pick the milestone listed first).
4. Draft the blueprint per §4.1, **with §4.1 step 5 skipped**
   (auto-approve per §15.2). Use your best interpretation of the slug
   name and the surrounding milestone context. Open questions go into
   the blueprint's `Open questions` section.
5. Create/update via the schema-v3 lifecycle transaction, append history with
   `Outcome: autopilot: in-progress`
   (§15.3), commit. Exit this iteration.

If every active milestone's blueprint backlog is already covered
(every listed blueprint exists as a file), and no inbox notifications
need processing, **exit immediately**. PM has nothing to draft this
iteration — the driver will invoke you again next interval, and you
will exit again until something changes.

PM does **not** invent new milestones or new "Blueprints"
entries in autonomous mode. The user defines the milestone structure
before enabling autonomous mode (see §15.5); PM only fills in
blueprint details within that structure. To extend the structure
mid-run, the user uses one of the paths in §15.7.

### 4.6 Execution-route selection (DEC-017, W-206)

PM selects an execution route for each task; there is no fixed/default route.

- **Dock orchestration**: write a blueprint; Dock decomposes
  and dispatches Worker / Scout / Smith / Librarian; work integrates
  through `studio`. Use for anything that benefits from parallel,
  specialized roles. This is the normal path — most work stays here.
- **Artisan single-role**: hand one task to the **Artisan**, which performs the
  whole Dock + Worker + Scout + Smith + Librarian scope by itself — build,
  **investigation / web research, and knowledge work included** — on a
  `satchel` branch and, after Guardian + Observer, integrates it into
  `studio`. Use when a single agent end-to-end is simpler than spinning up
  the pipeline. Route research/investigation and knowledge requests to the
  **Artisan itself**. The Artisan is a singleton (one only). Honor the
  blueprint's `Execution route hint` (`artisan | dock | pm_direct | auto`);
  on `auto`, you decide.

To dispatch Artisan work (when `[artisan] enabled = true`):

1. Write `__garelier/<pm_id>/_crew/artisan/assignment.md` from
   `garelier-artisan/templates/artisan_assignment.md`, then **dispatch the
   Artisan as a subagent (DEC-057 execution substrate)** per
   `../../../garelier-core/references/role_subagent_dispatch.md` (Agent tool,
   `isolation: worktree`) — not a terminal bay. Choose the role model by
   judgment density (`../../../garelier-core/references/model_routing.md`).
2. The Artisan runs to completion, submits its gated satchel through the shared
   merge gate with an expected studio SHA, and writes `report.md`. If the SHA is
   stale, it forward-integrates and repeats quality/Guardian/Observer gates.

**Librarian is not dispatched by PM.** It is a Dock-orchestrated role. To
get knowledge/registry/runbook work done, write a blueprint with
`Preferred role hint: librarian`; Dock dispatches the Librarian.

Legacy `lane.lock` is a compatibility artifact only: current Garelier neither
generates nor uses it for control. Migration may detect it and ask the operator
to complete/retire old runtime state; it never selects a route or blocks work.
