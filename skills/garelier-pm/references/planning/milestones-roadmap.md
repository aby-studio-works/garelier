# Garelier PM Milestones and Roadmap Reference

## §5. Milestone and roadmap management

### 5.1 Milestones

A milestone is a user-visible deliverable. Examples: "MVP completion",
"Steam early access launch", "Mod SDK release".

Use `__garelier/<pm_id>/control/templates/milestone.md`. Save one canonical
record at `__garelier/<pm_id>/control/milestones/<slug>.md`. Keep
`control/project_dashboard/roadmap.md` as a short index of active and planned
milestones. Shipped/abandoned state remains in the canonical milestone file and
git history; do not grow a completion log in the dashboard.

Milestones may run in parallel. Dock handles the parallel phase
breakdown; PM just declares them.

**Risk-first sequencing (DEC-070).** Every milestone names its riskiest
unknown as the FIRST entry of "Risks and unknowns" (template comment), and
the milestone's first dispatched work targets it — a spike, a Scout
inspection, or the directly-affected blueprint — never the safest item. A
project with no completion path through its hardest problem has no
completion estimate at all; retire the unknown while the sunk cost is
smallest. Blueprints that retire a dashboard risk or a riskiest unknown
carry `Kills risk:` in Identity, and dispatch prefers those while
high/critical risks stay open. The control graph emits a
`risk-first-drift` advisory (warning) when high/critical risks are active
but no open high/critical-priority backlog row exists — treat it as a
planning prompt: queue or re-prioritize risk-killing work, or downgrade a
stale risk. It never fails `--validate`.

### 5.1b Milestone-close retrospective (DEC-067)

When marking a milestone shipped (and at most once per milestone — never
manufacture lessons), harvest what went wrong mechanically and decide what
deserves a rule:

1. Run `bun garelier-core/scripts/retro_digest.ts --project <root>
   --pm-id <id> [--since <milestone start>]` — a zero-LLM digest of
   rework/refuted/blocked events, non-success gate results, and the
   "Context pack gaps" sections from archived dispatch reports (DEC-071:
   what producers had to rediscover that the blueprint should have
   carried).
2. For any cause that appears MORE THAN ONCE, draft a
   `knowledge_update_request` naming the rule, trigger
   (`role_index.toml [[triggers]]`), or AGENTS.md §0 principle that would
   have prevented it. One-off incidents normally do not become rules.
   A RECURRING context-pack gap is different: it means the PM's blueprints
   under-specify that area — fix the blueprint authoring habit (Context
   pack contents) rather than writing a producer-side rule.
3. PM approves; Librarian applies (DEC-029). Record the retro outcome in
   the milestone file's Notes (even when the outcome is "no recurring
   causes — no knowledge change", so the next reader knows it ran).

### 5.2 Roadmap

The roadmap orders and links canonical milestones in user-visible time. Use the
seeded `control/project_dashboard/roadmap.md` format. Update
`__garelier/<pm_id>/control/project_dashboard/roadmap.md` whenever
priorities shift.

The roadmap is a planning artifact. It does not bind execution; if
reality diverges, update it.
