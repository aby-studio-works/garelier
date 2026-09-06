<!-- absorbed-from: garelier-pm/SKILL.md ## Default PM Iteration -->

# Default PM iteration

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

For a normal PM turn:

1. Read the pre-flight material and the reference for the user request.
2. Resolve the exact `control.toml` schema/storage pair. Schema v3 is the only
   supported Control format; reject schema v1/v2 and unknown combinations
   explicitly. Inspect the bounded session resume: Current, ordered Checkpoints,
   referenced Backlogs, nearby Roadmap/Milestone graph, and relevant Notes/gates.
   Never scan `control/`.
3. On a planning turn (blueprint / milestone / roadmap), apply your own
   planning lens and set the role lenses: read the active group of the
   `pm.planning` pack (`../garelier-core/templates/lenses/lens_registry.toml`) and
   frame the plan within its focus/avoid, then set per-role Lens Groups in the
   blueprint's `## Lens selection` section — or leave them to `[lenses.defaults]`
   in `setup_config.toml`. Dispatch copies the resolved Lens into each
   `assignment.md` `## Equipped lens`. A Lens tunes judgment focus only — never
   authority, permissions, write paths, MUST-BLOCK conditions, or handoff
   format. Verify with `bun ../garelier-core/driver/src/lenses.ts
   parse-blueprint --blueprint <path>` or `... defaults --config <setup_config>`.
4. Choose one PM-owned action: clarify with the user, update control
   artifacts, request Dock work, accept/commit an inspection, run a
   setup/persistent-container workflow, or prepare a promote.
5. Keep durable state in `control/` and transient coordination in
   `runtime/control/`; there is no third state tree. In schema v3, direct
   Markdown authoring is valid after strict validation, while automated/shared
   multi-file activation, archive, relation-retirement, purge, and
   revision-protected changes use `garelier control` transactions. Schema v1/v2
   and unknown formats are rejected explicitly.
6. Commit each coherent PM-owned persistent change after strict validation. In
   schema v3, preserve curated Dashboard text and retired relation/archive
   history; generated markers may change only through the renderer. Do not
   create a commit when content is identical and only a timestamp would change.
7. Report only the delta and any required user approval or Dock action. Do not restate the request, plan, unchanged context, or bullet content.

For the autonomous dispatch loop, follow
`references/autonomous-mode.md` §15.4. It is intentionally one iteration
only and must exit promptly when no PM action is required.
